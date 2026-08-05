export async function POST(request: Request) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return new Response("notification not configured", { status: 500 });
  }

  const userAgent = request.headers.get("user-agent") ?? "unknown";
  const when = new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Perth",
    dateStyle: "full",
    timeStyle: "short",
  });

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "RooWatch <notify@trynoisy.com>",
      to: ["ross@roowatch.com.au"],
      subject: "Someone clicked Reserve my spot for $1",
      text: [
        "G'day Ross,",
        "",
        "Someone just clicked the $1 reserve button on roowatch.com.au.",
        "",
        `Time: ${when} (Perth time)`,
        `Browser: ${userAgent}`,
        "",
        "If they finish checkout, the payment lands in Stripe with their email and phone.",
        "",
        "RooWatch",
      ].join("\n"),
    }),
  });

  return new Response(null, { status: 204 });
}
