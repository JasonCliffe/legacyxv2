// functions/api/enquiry.js

export async function onRequestPost(context) {
  try {
    // Optional: basic same-origin protection
    const origin = context.request.headers.get("Origin") || "";
    const hostOrigin = new URL(context.request.url).origin;
    if (origin && origin !== hostOrigin) {
      return json({ ok: false, error: "Bad origin" }, 403);
    }

    const contentType = context.request.headers.get("Content-Type") || "";
    if (!contentType.includes("application/json")) {
      return json({ ok: false, error: "Expected JSON" }, 415);
    }

    const { page, name, email, topic, message, turnstileToken } =
      await context.request.json();

    const cleanPage = (page || "").toString().trim();
    const cleanName = (name || "").toString().trim().slice(0, 80);
    const cleanEmail = (email || "").toString().trim().slice(0, 120);
    const cleanTopic = (topic || "").toString().trim().slice(0, 120);
    const cleanMessage = (message || "").toString().trim().slice(0, 4000);
    const token = (turnstileToken || "").toString().trim();

    if (!cleanTopic) return json({ ok: false, error: "Topic is required." }, 400);
    if (!cleanMessage) return json({ ok: false, error: "Message is required." }, 400);

    // Validate email if provided
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return json({ ok: false, error: "Please enter a valid email address." }, 400);
    }

    // Turnstile verify
    const secret = context.env.TURNSTILE_SECRET;
    if (!secret) return json({ ok: false, error: "Server missing TURNSTILE_SECRET." }, 500);
    if (!token) return json({ ok: false, error: "Verification required." }, 400);

    const ip =
      context.request.headers.get("CF-Connecting-IP") ||
      context.request.headers.get("X-Forwarded-For") ||
      "";

    const verifyResp = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret,
          response: token,
          remoteip: ip
        })
      }
    );

    const verify = await verifyResp.json();
    if (!verify.success) {
      return json({ ok: false, error: "Verification failed. Try again." }, 400);
    }

    // Resend send
    const resendKey = context.env.RESEND_API_KEY;
    const toEmail = context.env.TO_EMAIL;

    const fromEmail = context.env.FROM_EMAIL;

    if (!resendKey || !toEmail || !fromEmail) {
      return json(
        { ok: false, error: "Server missing RESEND_API_KEY / TO_EMAIL / FROM_EMAIL." },
        500
      );
    }

    // --- UPDATED LOGIC FOR ROUTING ---
    const pageLabel = cleanPage === "business" ? "Business/Sponsorship" 
                    : cleanPage === "drop-one" ? "Drop One" 
                    : "Merch";

    const sourceUrl = cleanPage === "business" ? "https://legacyxv2.co.uk/business.html"
                    : cleanPage === "drop-one" ? "https://legacyxv2.co.uk/drop-one.html"
                    : "https://legacyxv2.co.uk/merch.html";
    // ---------------------------------

    const subject = `LegacyXV2 ${pageLabel} — ${cleanTopic}`;

    const text = [
      `Page: ${pageLabel}`,
      `Source: ${sourceUrl}`,
      cleanName ? `Name: ${cleanName}` : null,
      cleanEmail ? `Email: ${cleanEmail}` : null,
      "",
      cleanMessage
    ]
      .filter(Boolean)
      .join("\n");

    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject,
        text,
        // Resend expects "replyTo" (camelCase). Some clients accept "reply_to",
        // but this is the canonical field in most docs/SDKs.
        replyTo: cleanEmail || undefined
      })
    });

    if (!resendResp.ok) {
      const detail = await resendResp.text();
      return json(
        { ok: false, error: "Email send failed.", detail: detail.slice(0, 800) },
        502
      );
    }

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ ok: false, error: "Unexpected error." }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
