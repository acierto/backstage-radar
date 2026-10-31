// Extracts @user and @org/team mentions from Markdown, ignoring code and quoted replies
// (a quoted "@acierto said..." is not a new ping).
//
// Not every @mention is a question for that person. A mention only counts as a ping ("users") when
// the comment is plausibly addressed to them. It is a reference ("refs") when:
//   - the comment opens by addressing someone else ("Hi @alice, can you run with what @bob shared?")
//     and the person is not addressed at the start of any line, or
//   - it sits on a "cc @x" / "/cc @x" / "fyi @x" line.
const USER = /(^|[^\w`/@.-])@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})(\/[a-z\d][\w.-]*)?(?![\w@])/gi;
const GREETING = String.raw`(?:(?:hi|hey|hello|hej|dear|thanks|thank you|ping|ok|cool|great)\b[\s,!.]*)?`;
const LEADING = new RegExp(String.raw`^\s*${GREETING}((?:@[\w-]+(?:\/[\w.-]+)?[\s,:!.]*(?:and\s+|&\s+)?)+)`, 'i');
const CC_LINE = /^\s*(?:\/?cc|fyi|\bcc\b)[\s:]/i;

function clean(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

const loginsIn = (s) => [...s.matchAll(/@([\w-]+)(\/[\w.-]+)?/g)].filter((m) => !m[2]).map((m) => m[1].toLowerCase());

export function extractMentions(markdown, org) {
  const text = clean(markdown);
  const lines = text.split('\n').filter((l) => l.trim());

  const all = new Set();
  const teams = new Set();
  for (const m of text.matchAll(USER)) {
    const login = m[2].toLowerCase();
    if (m[3]) {
      if (!org || login === org.toLowerCase()) teams.add(m[3].slice(1).toLowerCase());
    } else {
      all.add(login);
    }
  }

  // Who each line opens by addressing, and who only appears on cc/fyi lines.
  const addressedAtLineStart = new Set();
  const ccOnly = new Set();
  for (const line of lines) {
    const lead = LEADING.exec(line);
    if (lead) loginsIn(lead[1]).forEach((l) => addressedAtLineStart.add(l));
    if (CC_LINE.test(line)) loginsIn(line).forEach((l) => ccOnly.add(l));
  }
  const firstLead = lines.length ? LEADING.exec(lines[0]) : null;
  const opensToOthers = firstLead ? loginsIn(firstLead[1]) : [];

  const users = [];
  const refs = [];
  for (const login of all) {
    let direct = true;
    if (ccOnly.has(login) && !addressedAtLineStart.has(login)) direct = false;
    else if (opensToOthers.length && !opensToOthers.includes(login) && !addressedAtLineStart.has(login)) direct = false;
    (direct ? users : refs).push(login);
  }
  return { users, teams: [...teams], refs };
}
