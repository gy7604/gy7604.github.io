import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  record: {
    id: number;
    event_type: string;
    title: string;
    body: string;
    request_id: string | null;
    created_at: string;
    recipient_teams: string[] | null;
  };
  old_record: Record<string, unknown> | null;
}

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
const supabaseServiceKey = secretKeys["default"];
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
const vapidSubject = Deno.env.get("VAPID_SUBJECT");
if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
  throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT secret이 필요합니다.");
}
webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

function isAllowedPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== "string" || endpoint.length < 1 || endpoint.length > 4096 || /[^\x21-\x7E]/.test(endpoint)) return false;
  // Validate the full authority: credentials, spoofed hosts and backslashes are forbidden.
  return new RegExp("^https://(fcm\\.googleapis\\.com|updates\\.push\\.services\\.mozilla\\.com|([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+push\\.apple\\.com|([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+notify\\.windows\\.com)(:443)?/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+$").test(endpoint);
}

Deno.serve(async (req) => {
  try {
    const authorization = req.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 2048) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const authorizationHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization))),
      b => b.toString(16).padStart(2, "0")
    ).join("");
    const { data: authorized, error: authorizationError } = await supabase.rpc(
      "app_verify_push_webhook", { p_authorization_hash: authorizationHash }
    );
    if (authorizationError || authorized !== true) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: authorizationError ? 503 : 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: { "Content-Type": "application/json" } });
    }

    const payload: WebhookPayload = await req.json();
    if (payload.table !== "notifications" || payload.type !== "INSERT") {
      return new Response(JSON.stringify({ success: true, message: "Ignored event" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const notification = payload.record;

    // 알림에 지정된 조의 활성 사용자 모두에게 발송
    let usersQuery = supabase
      .from("app_users")
      .select("id, name")
      .eq("is_active", true);

    if (notification.recipient_teams?.length) {
      usersQuery = usersQuery.in("team", notification.recipient_teams);
    }
    const { data: users, error: userError } = await usersQuery;
    if (userError) throw userError;
    const userIds = (users ?? []).map((user) => user.id);
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ success: true, sent: 0, message: "Target user not found" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const { data: subscriptions, error: subscriptionError } = await supabase
      .from("push_subscriptions")
      .select("id, user_id, user_name, subscription")
      .in("user_id", userIds);

    if (subscriptionError) throw subscriptionError;
    if (!subscriptions || subscriptions.length === 0) {
      return new Response(JSON.stringify({ success: true, sent: 0, message: "No subscriptions for target user" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const pushPayload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      event_type: notification.event_type,
      request_id: notification.request_id,
      notification_id: notification.id,
    });

    let sentCount = 0;
    let failedCount = 0;
    for (const row of subscriptions) {
      try {
        if (!isAllowedPushEndpoint(row.subscription?.endpoint)) {
          failedCount++;
          console.warn("Blocked subscription endpoint", { subscriptionId: row.id });
          continue;
        }
        await webpush.sendNotification(row.subscription, pushPayload);
        sentCount++;
        console.log(`알림 전송 성공: ${row.user_name ?? row.user_id}`);
      } catch (error) {
        failedCount++;
        const statusCode = error instanceof Error ? (error as Error & { statusCode?: number }).statusCode : undefined;
        console.error(`알림 전송 실패: ${row.user_name ?? row.user_id}`, error);
        if (statusCode === 404 || statusCode === 410) {
          // Preserve the user's subscription record until explicit disable.
          // Expired endpoints cannot deliver; the signed-in client can renew its own subscription.
          console.warn("푸시 주소 만료: 구독 기록 유지", {subscription_id: row.id, statusCode});
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      sent: sentCount,
      failed: failedCount,
      total: subscriptions.length,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Push notification function error:", error);
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});