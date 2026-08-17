/**
 * How long a member's lead brief may be.
 *
 * These lived as three different numbers in three files: the wizard checked
 * 500, every API sliced at 600, and Claude was told "under 130 words" which is
 * about 780 characters. So the AI wrote 755, the wizard called it too long, and
 * had it been saved the API would have quietly cut 155 characters off the end.
 *
 * One number, imported everywhere, so they cannot drift apart again.
 */

/** The hard ceiling. Anything longer is refused, never silently truncated. */
export const BRIEF_MAX = 1000;

/**
 * What we ask Claude to stay under. Deliberately below BRIEF_MAX so a member
 * can add a line of their own to a generated brief without hitting the wall.
 */
export const BRIEF_AI_MAX = 800;

/** Below this there is not enough to match a post against. */
export const BRIEF_MIN = 20;
