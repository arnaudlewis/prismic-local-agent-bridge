import { createHash } from "node:crypto"
import type { ServerResponse } from "node:http"

import { escapeHtml } from "../httpUtils.ts"
import { prismicLogoSvg } from "./logo.ts"

// The HTML pages of the connect popup. Plain CSS with the editor-ui tokens (the daemon can't import the design system).
// Every dynamic value is escaped by the `html` tag: a string is text, only a value made by `html` is markup.

class Html {
  readonly value: string

  constructor(value: string) {
    this.value = value
  }
}

function html(strings: TemplateStringsArray, ...values: Array<string | Html>): Html {
  let result = strings[0] ?? ""
  values.forEach((value, index) => {
    result += (value instanceof Html ? value.value : escapeHtml(value)) + (strings[index + 1] ?? "")
  })
  return new Html(result)
}

const codeFont = "source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace"

const styles = `
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: rgb(249, 248, 249); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif; }
main { box-sizing: border-box; width: 400px; max-width: calc(100vw - 32px); display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid rgb(228, 226, 228); border-radius: 12px; background: white; box-shadow: 0px 4px 16px 0px rgba(0, 0, 0, 0.05), 0px 1px 4px 0px rgba(0, 0, 0, 0.02); }
h1 { margin: 0; font-size: 14px; font-weight: 600; line-height: 28px; color: rgb(26, 21, 35); }
p { margin: 0; font-size: 13px; line-height: 20px; color: rgb(111, 110, 119); }
code { font-family: ${codeFont}; font-size: 12px; padding: 2px 6px; border-radius: 8px; background: rgb(244, 242, 244); color: rgb(26, 21, 35); word-break: break-all; }
strong { color: rgb(26, 21, 35); }
.notice { padding: 8px 12px; border: 1px solid rgb(250, 199, 190); border-radius: 8px; background: rgb(255, 240, 238); color: rgb(202, 50, 20); }
form { display: flex; justify-content: flex-end; gap: 8px; margin: 0; }
button { height: 32px; padding: 0 12px; border-radius: 6px; font: inherit; font-size: 12px; line-height: 16px; font-weight: 600; cursor: pointer; }
button.primary { color: white; background: rgb(110, 86, 207); border: 1px solid rgb(87, 70, 175); }
button.primary:hover { background: rgb(100, 79, 193); }
button.secondary { color: rgb(26, 21, 35); background: white; border: 1px solid rgb(220, 219, 221); }
button.secondary:hover { background: rgb(244, 242, 244); }
button:focus-visible { outline: none; box-shadow: 0px 0px 0px 2px rgba(124, 102, 220, 0.3); }
`

const autoCloseScript = "setTimeout(function () { window.close() }, 1500)"

function cspHash(text: string): string {
  return `'sha256-${createHash("sha256").update(text).digest("base64")}'`
}

// The hashes are computed once: the inline style and script are the only ones the pages are allowed to carry. There
// is no form-action directive on purpose: browsers apply it to the redirects after a submission too, and the allow
// button ends on the MCP's and the identity provider's hosts.
const contentSecurityPolicy = [
  "default-src 'none'",
  `style-src ${cspHash(styles)}`,
  `script-src ${cspHash(autoCloseScript)}`,
  "img-src data:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ")

interface PageArgs {
  title: string
  body: Html[]
  form?: Html
  tone?: "error"
  // Closes the window by itself; the text stays when the browser refuses.
  autoClose?: boolean
}

function renderPage(page: PageArgs): string {
  const paragraphs = page.body.map((paragraph) => paragraph.value).join("")
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${page.title}</title><style>${new Html(styles)}</style></head><body><main>${new Html(prismicLogoSvg)}<h1>${page.title}</h1>${new Html(paragraphs)}${page.form ?? new Html("")}</main>${new Html(page.autoClose === true ? `<script>${autoCloseScript}</script>` : "")}</body></html>`.value
}

function paragraph(content: Html, tone?: "error"): Html {
  return html`<p${new Html(tone === "error" ? ' class="notice"' : "")}>${content}</p>`
}

export function sendPage(res: ServerResponse, status: number, page: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": contentSecurityPolicy,
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  res.end(page)
}

interface ConsentPageArgs {
  attemptId: string
  origin: string
  // The repository the origin stands for, when it is a deployed editor.
  repository: string | undefined
  projectDir: string
  signedIn: boolean
}

export function consentPage(args: ConsentPageArgs): string {
  const { attemptId, origin, repository, projectDir, signedIn } = args
  const repositoryText = repository === undefined ? new Html("") : html` (repository <strong>${repository}</strong>)`
  const lines = [
    paragraph(
      html`<code>${origin}</code>${repositoryText} wants to run AI agents on this computer, in <code>${projectDir}</code>. They act on your Prismic content with your Prismic account.`,
    ),
  ]
  if (!signedIn) lines.push(paragraph(html`You'll sign in to Prismic next.`))
  return renderPage({
    title: "Connect the Page Builder to this computer",
    body: lines,
    form: html`<form method="post" action="/connect/decision"><input type="hidden" name="attempt" value="${attemptId}"><button class="secondary" type="submit" name="decision" value="deny">Cancel</button><button class="primary" type="submit" name="decision" value="allow">${signedIn ? "Allow" : "Allow and sign in"}</button></form>`,
  })
}

export function connectedPage(): string {
  return renderPage({
    title: "Connected",
    body: [paragraph(html`You can close this window and go back to the Page Builder.`)],
    autoClose: true,
  })
}

export function canceledPage(): string {
  return renderPage({
    title: "Connection canceled",
    body: [paragraph(html`You can close this window.`)],
    autoClose: true,
  })
}

export function signInFailedPage(): string {
  return renderPage({
    title: "Sign-in failed",
    body: [paragraph(html`Prismic sign-in didn't complete. Close this window and try again from the Page Builder.`, "error")],
  })
}

export function errorPage(title: string, message: string): string {
  return renderPage({ title, body: [paragraph(html`${message}`, "error")] })
}

export const expiredMessage = "This request has expired. Start again from the Page Builder."
