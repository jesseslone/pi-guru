/**
 * The one place the bench touches the network.
 *
 * Sources fetch through here so the User-Agent, abort signal, and error shape are uniform, and so
 * unit tests — which must never hit the network — can see there is a single seam to avoid. Only
 * `fetch()` methods and the fetch-smoke script call this; converters are pure.
 */

/** GET a URL as bytes. Sends a bench User-Agent (GitHub requires one) and honours `signal`. */
export async function httpGetBytes(url: string, signal?: AbortSignal): Promise<Buffer> {
	const res = await fetch(url, {
		signal,
		headers: { "User-Agent": "pi-guru-bench", Accept: "application/vnd.github+json, application/json" },
	});
	if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
	return Buffer.from(await res.arrayBuffer());
}

/** GET a URL and parse it as JSON. */
export async function httpGetJson(url: string, signal?: AbortSignal): Promise<unknown> {
	return JSON.parse((await httpGetBytes(url, signal)).toString("utf8"));
}
