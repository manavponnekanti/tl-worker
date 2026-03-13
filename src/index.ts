interface Env {
  BUCKET: R2Bucket;
  KV: KVNamespace;
  TELEGRAM_TOKEN: string;
  TELEGRAM_USER_ID: string;
  GITHUB_PAT: string;
  GITHUB_REPO: string;
  PUBLIC_URL: string;
  R2_PUBLIC_URL: string;
}

async function telegramApi(token: string, method: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendEphemeral(env: Env, ctx: ExecutionContext, chatId: number, text: string): Promise<void> {
  const res = await telegramApi(env.TELEGRAM_TOKEN, "sendMessage", {
    chat_id: chatId,
    text,
  });
  const data = await res.json() as any;
  if (data.result?.message_id) {
    ctx.waitUntil(
      sleep(5000).then(() =>
        telegramApi(env.TELEGRAM_TOKEN, "deleteMessage", {
          chat_id: chatId,
          message_id: data.result.message_id,
        })
      )
    );
  }
}

async function githubApi(env: Env, method: string, endpoint: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "sundries-worker",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function buildMarkdown(date: string, slug: string, text: string, image?: { url: string; width: number; height: number }): string {
  let md = `---\ndate: ${date}\nslug: "${slug}"\n---\n${text}`;
  if (image) {
    const maxHeight = 300;
    let { width, height } = image;
    if (height > maxHeight) {
      width = Math.round(width * maxHeight / height);
      height = maxHeight;
    }
    md += `\n\n<img src="${image.url}" width="${width}" height="${height}" alt="">`;
  }
  return md;
}

async function downloadPhoto(env: Env, message: any, slug: string): Promise<{ url: string; width: number; height: number } | undefined> {
  if (!message.photo || message.photo.length === 0) return undefined;

  const photo = message.photo[message.photo.length - 1];
  const fileRes = await telegramApi(env.TELEGRAM_TOKEN, "getFile", { file_id: photo.file_id });
  const fileData = await fileRes.json() as any;
  const filePath = fileData.result.file_path;

  const imageRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
  const imageBytes = await imageRes.arrayBuffer();

  const r2Key = `sundries/${slug}.jpg`;
  await env.BUCKET.put(r2Key, imageBytes, {
    httpMetadata: { contentType: "image/jpeg" },
  });

  return {
    url: `${env.R2_PUBLIC_URL}/${r2Key}`,
    width: photo.width,
    height: photo.height,
  };
}

async function getFileSha(env: Env, slug: string): Promise<string> {
  const path = `/contents/src/content/sundries/${slug}.md`;
  const res = await githubApi(env, "GET", path + "?ref=main");
  if (!res.ok) throw new Error(`GitHub GET error: ${res.status}`);
  const data = await res.json() as any;
  return data.sha;
}

async function handleCreate(env: Env, ctx: ExecutionContext, message: any): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text || message.caption || "";
  const slug = String(Math.floor(Date.now() / 1000));
  const date = new Date().toISOString();

  const image = await downloadPhoto(env, message, slug);

  const markdown = buildMarkdown(date, slug, text, image);
  const path = `/contents/src/content/sundries/${slug}.md`;
  const commitRes = await githubApi(env, "PUT", path, {
    message: `Add sundries post ${slug}`,
    content: btoa(unescape(encodeURIComponent(markdown))),
    branch: "main",
  });

  if (!commitRes.ok) {
    const err = await commitRes.text();
    throw new Error(`GitHub API error: ${commitRes.status} ${err}`);
  }

  await env.KV.put(`msg:${message.message_id}`, slug);

  await sendEphemeral(env, ctx, chatId, `Published (${slug})! See it here: ${env.PUBLIC_URL}`);
}

async function handleEdit(env: Env, ctx: ExecutionContext, message: any): Promise<void> {
  const chatId = message.chat.id;
  const slug = await env.KV.get(`msg:${message.message_id}`);
  if (!slug) return; // Old post from before KV was added

  const sha = await getFileSha(env, slug);
  const text = message.text || message.caption || "";
  const image = await downloadPhoto(env, message, slug);

  // Extract original date from existing file to preserve it
  const fileRes = await githubApi(env, "GET", `/contents/src/content/sundries/${slug}.md?ref=main`);
  const fileData = await fileRes.json() as any;
  const existingContent = decodeURIComponent(escape(atob(fileData.content.replace(/\n/g, ""))));
  const dateMatch = existingContent.match(/^date:\s*(.+)$/m);
  const date = dateMatch ? dateMatch[1] : new Date().toISOString();

  const markdown = buildMarkdown(date, slug, text, image);
  const path = `/contents/src/content/sundries/${slug}.md`;
  const commitRes = await githubApi(env, "PUT", path, {
    message: `Update sundries post ${slug}`,
    content: btoa(unescape(encodeURIComponent(markdown))),
    sha,
    branch: "main",
  });

  if (!commitRes.ok) {
    const err = await commitRes.text();
    throw new Error(`GitHub API error: ${commitRes.status} ${err}`);
  }

  await sendEphemeral(env, ctx, chatId, `Updated (${slug})!`);
}

async function handleDelete(env: Env, ctx: ExecutionContext, message: any): Promise<void> {
  const chatId = message.chat.id;
  const originalMessageId = message.reply_to_message.message_id;
  const slug = await env.KV.get(`msg:${originalMessageId}`);

  if (!slug) {
    await sendEphemeral(env, ctx, chatId, "Couldn't find that post. It may predate the KV mapping.");
    return;
  }

  const sha = await getFileSha(env, slug);
  const path = `/contents/src/content/sundries/${slug}.md`;
  const deleteRes = await githubApi(env, "DELETE", path, {
    message: `Delete sundries post ${slug}`,
    sha,
    branch: "main",
  });

  if (!deleteRes.ok) {
    const err = await deleteRes.text();
    throw new Error(`GitHub API error: ${deleteRes.status} ${err}`);
  }

  await env.BUCKET.delete(`sundries/${slug}.jpg`);
  await env.KV.delete(`msg:${originalMessageId}`);

  await sendEphemeral(env, ctx, chatId, `Deleted (${slug})!`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    let chatId: number | undefined;

    try {
      const update = await request.json() as any;

      // Handle edited messages
      if (update.edited_message) {
        const msg = update.edited_message;
        chatId = msg.chat.id;
        if (String(msg.from.id) !== env.TELEGRAM_USER_ID) return new Response("OK");
        await handleEdit(env, ctx, msg);
        return new Response("OK");
      }

      const message = update.message;
      if (!message) return new Response("OK");

      chatId = message.chat.id;

      // Auth: single-user bot
      if (String(message.from.id) !== env.TELEGRAM_USER_ID) {
        return new Response("OK");
      }

      // Handle /delete reply
      if (message.text === "/delete" && message.reply_to_message) {
        await handleDelete(env, ctx, message);
        return new Response("OK");
      }

      // Ignore other bot commands
      if (message.text && message.text.startsWith("/")) {
        return new Response("OK");
      }

      await handleCreate(env, ctx, message);
    } catch (err: any) {
      if (chatId) {
        await sendEphemeral(env, ctx, chatId, `Error: ${err.message}`);
      }
    }

    return new Response("OK");
  },
};
