/** A refusal of a login or launch: shown to the person as a page, never as JSON. */
export class LtiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] ?? char,
  );

export function refusalPage(message: string): string {
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Не вдалося відкрити завдання</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}</style>
</head>
<body>
<h1>Не вдалося відкрити завдання</h1>
<p>${escapeHtml(message)}</p>
<p>Закрийте цю вкладку та відкрийте завдання в LMS ще раз.</p>
</body>
</html>
`;
}
