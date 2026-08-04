// Cloudflare Pages Function: POST /api/report → creates a GitHub issue.
//
// The GitHub token lives ONLY here, as a Pages secret (`GITHUB_ISSUES_TOKEN`) — it's
// never sent to the browser. The client POSTs a report; this adds the token and
// calls the GitHub API. Everything except the token is optional, so the feature
// works with just:  wrangler pages secret put GITHUB_ISSUES_TOKEN --project-name open-poly
//
// Optional upgrades (env-gated, no code change):
//   • TURNSTILE_SECRET  → verify a Cloudflare Turnstile token (spam protection).
//   • REPORTS (R2 bind) + PUBLIC_R2_BASE → upload doc/screenshot blobs and link
//     them (so big docs and images aren't crammed into the issue body).
//
// Not typechecked by the app build (tsconfig.app only includes `src`); Wrangler
// compiles it with esbuild.

const OWNER = "eitan27";
const REPO = "open-poly";
const MAX_BODY_BYTES = 6 * 1024 * 1024; // 6 MB request cap
const MAX_INLINE_DOC = 55_000; // GitHub issue body is ~65 k chars; leave headroom

interface Env {
  GITHUB_ISSUES_TOKEN: string;
  TURNSTILE_SECRET?: string;
  PUBLIC_R2_BASE?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  REPORTS?: { put(key: string, value: any, opts?: any): Promise<unknown> };
}

interface ReportPayload {
  category?: "bug" | "missing_feature" | "confusing" | "other";
  description?: string;
  doc?: string; // stringified .openpoly.json
  screenshot?: string; // PNG data URL
  meta?: { version?: string; ua?: string; url?: string };
  turnstileToken?: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  bug: "🐛 Bug",
  missing_feature: "✨ Missing feature",
  confusing: "❓ Confusing",
  other: "💬 Feedback",
};

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  if (!env.GITHUB_ISSUES_TOKEN) return json(500, { error: "reporting not configured" });

  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return json(413, { error: "report too large" });

  let payload: ReportPayload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const description = (payload.description ?? "").trim();
  if (!description) return json(400, { error: "description is required" });

  // Optional spam check — only enforced when a Turnstile secret is set.
  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, payload.turnstileToken, request.headers.get("cf-connecting-ip"));
    if (!ok) return json(403, { error: "failed spam check" });
  }

  const category = payload.category ?? "other";
  const meta = payload.meta ?? {};
  const now = new Date().toISOString();

  // Optionally offload big blobs to R2 and link them; else inline what fits.
  const links: string[] = [];
  if (env.REPORTS && env.PUBLIC_R2_BASE) {
    const stamp = `${now.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
    if (payload.doc) {
      await env.REPORTS.put(`reports/${stamp}.openpoly.json`, payload.doc, { httpMetadata: { contentType: "application/json" } });
      links.push(`- [document (.openpoly.json)](${env.PUBLIC_R2_BASE}/reports/${stamp}.openpoly.json)`);
    }
    const png = dataUrlToBytes(payload.screenshot);
    if (png) {
      await env.REPORTS.put(`reports/${stamp}.png`, png, { httpMetadata: { contentType: "image/png" } });
      links.push(`![screenshot](${env.PUBLIC_R2_BASE}/reports/${stamp}.png)`);
    }
  }

  const bodyParts: string[] = [description, "", "---", ""];
  bodyParts.push(
    `| field | value |`,
    `|---|---|`,
    `| category | ${CATEGORY_LABEL[category] ?? category} |`,
    `| version | \`${meta.version ?? "?"}\` |`,
    `| url | ${meta.url ?? "?"} |`,
    `| browser | ${(meta.ua ?? "?").replace(/\|/g, "\\|")} |`,
    `| when | ${now} |`,
    "",
  );
  if (links.length) bodyParts.push("### Attachments", ...links, "");
  else if (payload.doc && payload.doc.length <= MAX_INLINE_DOC) {
    bodyParts.push("<details><summary>document (.openpoly.json)</summary>", "", "```json", payload.doc, "```", "", "</details>");
  } else if (payload.doc) {
    bodyParts.push(`_document omitted — ${payload.doc.length} chars exceeds the inline limit; enable R2 to attach it._`);
  }

  const title = `[${category}] ${description.split("\n")[0].slice(0, 80)}`;
  const gh = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_ISSUES_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "open-poly-report",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title, body: bodyParts.join("\n") }),
  });

  if (!gh.ok) {
    const detail = await gh.text().catch(() => "");
    return json(502, { error: "GitHub rejected the report", status: gh.status, detail: detail.slice(0, 300) });
  }
  const issue = (await gh.json()) as { html_url?: string; number?: number };
  return json(200, { url: issue.html_url, number: issue.number });
};

async function verifyTurnstile(secret: string, token: string | undefined, ip: string | null): Promise<boolean> {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = (await res.json()) as { success?: boolean };
  return !!out.success;
}

function dataUrlToBytes(dataUrl: string | undefined): Uint8Array | null {
  if (!dataUrl || !dataUrl.startsWith("data:")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
