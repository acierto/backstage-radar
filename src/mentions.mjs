// Extracts @user and @org/team mentions from Markdown, ignoring code and quoted replies
// (a quoted "@acierto said..." is not a new ping).
const USER = /(^|[^\w`/@.-])@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})(\/[a-z\d][\w.-]*)?(?![\w@])/gi;

export function extractMentions(markdown, org) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');

  const users = new Set();
  const teams = new Set();
  for (const m of text.matchAll(USER)) {
    const login = m[2].toLowerCase();
    if (m[3]) {
      if (!org || login === org.toLowerCase()) teams.add(m[3].slice(1).toLowerCase());
    } else {
      users.add(login);
    }
  }
  return { users: [...users], teams: [...teams] };
}
