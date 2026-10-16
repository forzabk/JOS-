
const PIXEL_ID = "883924624710976";

export async function onRequestPost({ request, env }) {
  const origin = new URL(request.url).origin;

  if (request.headers.get("Origin") !== origin) {
    return new Response("Forbidden", { status: 403 });
  }

  if (!env.META_CAPI_TOKEN) {
    return new Response("CAPI token missing", { status: 500 });
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { event_name, event_id } = data || {};

  if (
    !["PageView", "Lead"].includes(event_name) ||
    typeof event_id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(event_id)
  ) {
    return new Response("Invalid event", { status: 400 });
  }

  const cookies = request.headers.get("Cookie") || "";
  const getCookie = name => {
    const item = cookies.split("; ").find(
      c => c.startsWith(name + "=")
    );
    return item ? item.slice(name.length + 1) : null;
  };

  const user_data = {};

  const ip = request.headers.get("CF-Connecting-IP");
  const ua = request.headers.get("User-Agent");

  if (ip) user_data.client_ip_address = ip;
  if (ua) user_data.client_user_agent = ua;

  const fbp = getCookie("_fbp");
  const fbc = getCookie("_fbc");

  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  let source = origin + "/";
  const referer = request.headers.get("Referer");

  if (referer) {
    try {
      const url = new URL(referer);
      if (url.origin === origin) source = url.href;
    } catch {}
  }

  const payload = {
    access_token: env.META_CAPI_TOKEN,
    data: [{
      event_name,
      event_id,
      event_time: Math.floor(Date.now() / 1000),
      action_source: "website",
      event_source_url: source,
      user_data
    }]
  };

  if (env.META_TEST_EVENT_CODE) {
    payload.test_event_code = env.META_TEST_EVENT_CODE;
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v23.0/${PIXEL_ID}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      console.error("Meta CAPI error", response.status);
    }

    return new Response(
      JSON.stringify({ ok: response.ok }),
      {
        status: response.ok ? 200 : 502,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch {
    return new Response("CAPI request failed", {
      status: 502
    });
  }
}
