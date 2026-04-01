export function layout({ title, body, script = '' }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="stylesheet" href="/static/styles.css" />
</head>
<body>
  <div class="aurora"></div>
  <main class="shell">${body}</main>
  <script type="module">${script}</script>
</body>
</html>`;
}
