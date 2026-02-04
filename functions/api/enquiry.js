export async function onRequestGet(context) {
  // Healthcheck / debug endpoint (no secrets exposed)
  // Visit: https://www.legacyxv2.co.uk/api/enquiry
  return json({
    ok: true,
    service: "enquiry",
    env: {
      TURNSTILE_SECRET: !!context.env.TURNSTILE_SECRET,
      RESEND_API_KEY: !!(context.env.RESEND_API_KEY || context.env.RESEND_KEY),
      TO_EMAIL: !!(context.env.TO_EMAIL || context.env.RESEND_TO_EMAIL || context.env.RESEND_TO),
      FROM_EMAIL: !!(context.env.FROM_EMAIL || context.env.RESEND_FROM_EMAIL || context.env.RESEND_FROM)
    }
  });
}

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

    let verifyResp;
    try {
      verifyResp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret,
          response: token,
          remoteip: ip
        })
      });
    } catch (err) {
      return json({ ok: false, error: "Turnstile verify fetch failed." }, 502);
    }

    const verify = await verifyResp.json();
    if (!verify.success) {
      return json({ ok: false, error: "Verification failed. Try again." }, 400);
    }

    // Resend configuration (supports BOTH naming styles)
    const resendKey = context.env.RESEND_API_KEY || context.env.RESEND_KEY;

    // Cloudflare uses RESEND_TO_EMAIL / RESEND_FROM_EMAIL
    const toEmail =
      context.env.TO_EMAIL ||
      context.env.RESEND_TO_EMAIL ||
      context.env.RESEND_TO;

    const fromEmail =
      context.env.FROM_EMAIL ||
      context.env.RESEND_FROM_EMAIL ||
      context.env.RESEND_FROM;

    const missing = [];
    if (!resendKey) missing.push("RESEND_API_KEY");
    if (!toEmail) missing.push("TO_EMAIL or RESEND_TO_EMAIL");
    if (!fromEmail) missing.push("FROM_EMAIL or RESEND_FROM_EMAIL");

    if (missing.length) {
      return json({ ok: false, error: `Server missing: ${missing.join(", ")}` }, 500);
    }

    const pageLabel = cleanPage === "drop-one" ? "Drop One" : "Merch";
    const sourceUrl =
      cleanPage === "drop-one"
        ? "https://legacyxv2.co.uk/drop-one.html"
        : "https://legacyxv2.co.uk/merch.html";

    const subject = `LegacyXV2 ${pageLabel} — ${cleanTopic}`;

    const text = [
      `Page: ${pageLabel}`,
      `Source: ${sourceUrl}`,
      cleanName ? `Name: ${cleanName}` : null,
      cleanEmail ? `Email: ${cleanEmail}` : null,
      "",
      cleanMessage
    ].filter(Boolean).join("\n");

    let resendResp;
    try {
      resendResp = await fetch("https://api.resend.com/emails", {
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
          reply_to: cleanEmail || undefined
        })
      });
    } catch (err) {
      return json({ ok: false, error: "Resend fetch failed." }, 502);
    }

    if (!resendResp.ok) {
      const detailText = await resendResp.text();
      return json(
        {
          ok: false,
          error: "Email send failed.",
          detail: detailText.slice(0, 1200)
        },
        502
      );
    }

    return json({ ok: true }, 200);
  } catch (e) {
    // Return the error message for debugging (safe-ish; doesn’t include env values)
    return json(
      { ok: false, error: "Unexpected error.", detail: String(e?.message || e).slice(0, 500) },
      500
    );
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