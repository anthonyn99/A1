// The worker's answers: a JSON response, and an error that carries its status.
export function fail(status, message, extra) { return Object.assign(new Error(message), { status, extra }); }
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
