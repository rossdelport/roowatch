/**
 * Turning whatever a member types into a watchable Facebook group.
 * They may paste a full link, a bare facebook.com path, or just a name.
 */

export type ParsedGroup = { name: string; url: string | null; slug: string | null };

const GROUP_RE = /(?:facebook\.com|fb\.com)\/groups\/([^/?#\s]+)/i;

/** Pretty label from a slug: "trustedtradiesperth" stays, "perth-solar" -> "Perth Solar" */
function labelFromSlug(slug: string): string {
  if (/^\d+$/.test(slug)) return `Group ${slug}`;
  const spaced = slug.replace(/[-_.]+/g, " ").trim();
  return spaced
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function parseGroupInput(raw: string): ParsedGroup | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  const match = input.match(GROUP_RE);
  if (match) {
    const slug = match[1].replace(/\/$/, "");
    if (!slug) return null;
    return {
      slug,
      url: `https://www.facebook.com/groups/${slug}`,
      name: labelFromSlug(slug),
    };
  }

  // Anything else (a bare name, or a link we cannot resolve such as a
  // facebook.com/share/g/... redirect) is kept for Ross to look up on the
  // welcome call. Never drop it silently: losing it loses the member leads.
  return { name: input.slice(0, 120), url: null, slug: null };
}

/**
 * Apify sometimes returns the group URL rather than a post permalink.
 * Build a real permalink from the post id when that happens.
 */
export function postPermalink(
  rawUrl: string,
  groupUrl: string,
  postId: string
): string {
  const url = String(rawUrl ?? "").trim();
  const looksLikePost =
    /\/permalink\/|\/posts\/|story_fbid=|multi_permalinks=|\/videos\//i.test(url);
  if (url && looksLikePost) return url;

  const slug = String(groupUrl ?? "").match(GROUP_RE)?.[1];
  const id = String(postId ?? "").replace(/[^\d]/g, "");
  if (slug && id) return `https://www.facebook.com/groups/${slug}/permalink/${id}/`;

  return url || groupUrl || "";
}
