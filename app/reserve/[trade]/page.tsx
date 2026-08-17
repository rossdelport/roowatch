import type { Metadata } from "next";
import base from "../reserve.html?raw";

export const metadata: Metadata = {
  title: "RooWatch - Start getting leads",
  robots: { index: false, follow: false },
};

type Trade = {
  noun: string;
  article: "a" | "an";
  author: string;
  initials: string;
  group: string;
  post: string;
  amount: string;
};

const TRADES: Record<string, Trade> = {
  plumbers: {
    noun: "plumber", article: "a", author: "Sarah M.", initials: "SM",
    group: "Northern Beaches Community",
    post: 'Help! Our hot water died this morning and we have a newborn at home. Can anyone recommend a good <mark class="fb-hl">plumber</mark> near Dee Why? Happy to pay extra for same day.',
    amount: "800",
  },
  electricians: {
    noun: "electrician", article: "an", author: "Jack T.", initials: "JT",
    group: "Paddington Locals Brisbane",
    post: 'Our safety switch keeps tripping every night and half the house goes dark. Can anyone recommend a licensed <mark class="fb-hl">electrician</mark> who can come this week?',
    amount: "1,200",
  },
  removalists: {
    noun: "removalist", article: "a", author: "Dana P.", initials: "DP",
    group: "Gold Coast Community Board",
    post: 'Moving from Burleigh to Palm Beach next Friday. Three bedroom house and some heavy furniture. Who is a careful <mark class="fb-hl">removalist</mark> that turns up on time?',
    amount: "1,100",
  },
  handymen: {
    noun: "handyman", article: "a", author: "Mark R.", initials: "MR",
    group: "Adelaide Hills Chat",
    post: 'I have a list of little jobs. Sticky doors, a broken gate latch, shelves to hang. Any good <mark class="fb-hl">handyman</mark> around who does half days?',
    amount: "450",
  },
  landscapers: {
    noun: "landscaper", article: "a", author: "Emma W.", initials: "EW",
    group: "Perth Gardening and Lawns",
    post: 'The backyard turned into a jungle over winter. I want it cleared and new lawn down before Christmas. Who is a great <mark class="fb-hl">landscaper</mark> near Fremantle?',
    amount: "2,400",
  },
  painters: {
    noun: "painter", article: "a", author: "Nick H.", initials: "NH",
    group: "Hobart Home Advice",
    post: 'Getting the house ready to sell and the outside needs a full repaint. Which <mark class="fb-hl">painter</mark> did a great job for you? Happy to pay for quality.',
    amount: "3,500",
  },
  "air-con": {
    noun: "air con installer", article: "an", author: "Priya K.", initials: "PK",
    group: "Western Sydney Mums and Dads",
    post: 'Summer is coming and the bedrooms are ovens. Who installs <mark class="fb-hl">split systems</mark> and can fit us in before December?',
    amount: "1,800",
  },
  "gutter-cleaning": {
    noun: "gutter cleaner", article: "a", author: "Tom B.", initials: "TB",
    group: "Melbourne Bayside Community",
    post: 'Every time it rains the gutters overflow onto the deck. Who does <mark class="fb-hl">gutter cleaning</mark> around Brighton? Two storey house.',
    amount: "400",
  },
  cleaners: {
    noun: "cleaner", article: "a", author: "Lisa G.", initials: "LG",
    group: "Canberra Notice Board",
    post: 'End of lease clean needed in two weeks and the agent is fussy. Who is the best <mark class="fb-hl">bond cleaner</mark> you have used?',
    amount: "500",
  },
  "pest-control": {
    noun: "pest controller", article: "a", author: "Ryan C.", initials: "RC",
    group: "Sunshine Coast Community",
    post: 'Found termites in the back fence this morning and I am a bit worried. Who does <mark class="fb-hl">pest control</mark> up here and can come fast?',
    amount: "600",
  },
};

const BASE_POST =
  'Help! Our hot water died this morning and we have a newborn at home. Can anyone recommend a good <mark class="fb-hl">plumber</mark> near Dee Why? Happy to pay extra for same day.';

export default async function TradeReserve({
  params,
}: {
  params: Promise<{ trade: string }>;
}) {
  const { trade } = await params;
  const t = TRADES[trade];

  let html = base;
  if (t) {
    html = html
      .replace(
        '<h1>Your next customer is asking for you <span class="highlight">right now</span></h1>',
        `<h1>Your next customer is asking for ${t.article} <span class="highlight">${t.noun}</span> right now</h1>`
      )
      .replace("ask for a tradie they can trust", `ask for ${t.article} ${t.noun} they can trust`)
      .replace(">SM</span>", `>${t.initials}</span>`)
      .replace("Sarah M.", t.author)
      .replaceAll("Northern Beaches Community", t.group)
      .replace(BASE_POST, t.post)
      .replace("This post is worth $800", `This post is worth $${t.amount}`)
      // Carry the trade to signup so somebody clicking a plumber ad does not
      // have to tell us they are a plumber.
      .replace(
        /href="\/signup\?plan=(local|growth|scale)"/g,
        (_m, plan) => `href="/signup?plan=${plan}&trade=${encodeURIComponent(t.noun)}"`
      );
  }

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
