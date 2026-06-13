import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_ORIGIN = "https://dzm.burblesoft.com";
const COOKIE_PREFIX = "burble_proxy__";
const PROXY_PATH = "/burble-proxy";
const ACTIVE_DZ_COOKIE = `${COOKIE_PREFIX}active_dz_id`;

function buildUpstreamCookieHeader(request: NextRequest) {
    const cookiePairs = request.cookies
        .getAll()
        .filter((cookie) => cookie.name.startsWith(COOKIE_PREFIX))
        .map((cookie) => {
            const upstreamName = cookie.name.slice(COOKIE_PREFIX.length);
            return `${upstreamName}=${cookie.value}`;
        });

    return cookiePairs.join("; ");
}

function parseSetCookie(setCookieValue: string) {
    const parts = setCookieValue.split(";").map((part) => part.trim());
    const [nameValue, ...attributes] = parts;
    const separatorIndex = nameValue.indexOf("=");

    if (separatorIndex === -1) {
        return null;
    }

    const name = nameValue.slice(0, separatorIndex);
    const value = nameValue.slice(separatorIndex + 1);
    const parsedAttributes = new Map<string, string | true>();

    attributes.forEach((attribute) => {
        const attributeSeparator = attribute.indexOf("=");

        if (attributeSeparator === -1) {
            parsedAttributes.set(attribute.toLowerCase(), true);
            return;
        }

        parsedAttributes.set(
            attribute.slice(0, attributeSeparator).toLowerCase(),
            attribute.slice(attributeSeparator + 1),
        );
    });

    return {
        name,
        value,
        attributes: parsedAttributes,
    };
}

function splitSetCookieHeader(setCookieHeader: string) {
    return setCookieHeader.split(/, (?=[^;,]+=)/g);
}

function rewriteBody(body: string, request: NextRequest) {
    const requestOrigin = request.nextUrl.origin;

    // Plain URL replacements (HTML attributes, JS string literals)
    let result = body
        .replaceAll(`${requestOrigin}/`, `${PROXY_PATH}/`)
        .replaceAll(`${requestOrigin}`, PROXY_PATH)
        .replaceAll("https://dzm.burblesoft.com/", `${PROXY_PATH}/`)
        .replaceAll("http://dzm.burblesoft.com/", `${PROXY_PATH}/`)
        .replaceAll("//dzm.burblesoft.com/", `${PROXY_PATH}/`)
        .replaceAll("https://dzm.burblesoft.com", PROXY_PATH)
        .replaceAll("http://dzm.burblesoft.com", PROXY_PATH)
        .replaceAll("//dzm.burblesoft.com", PROXY_PATH);

    // JSON-escaped URL replacements (e.g. "baseUrl":"https:\/\/dzm.burblesoft.com\/")
    result = result
        .replaceAll(`${requestOrigin.replaceAll("/", "\\/")}\\/`, `${PROXY_PATH}\\/`)
        .replaceAll(requestOrigin.replaceAll("/", "\\/"), PROXY_PATH)
        .replaceAll("https:\\/\\/dzm.burblesoft.com\\/", `${PROXY_PATH}\\/`)
        .replaceAll("http:\\/\\/dzm.burblesoft.com\\/", `${PROXY_PATH}\\/`)
        .replaceAll("https:\\/\\/dzm.burblesoft.com", PROXY_PATH)
        .replaceAll("http:\\/\\/dzm.burblesoft.com", PROXY_PATH);

    return result;
}

function rewriteLocationHeader(location: string, request: NextRequest) {
    const upstreamHost = new URL(UPSTREAM_ORIGIN).host;
    const contextDzId =
        request.nextUrl.searchParams.get("dz_id") ?? request.nextUrl.searchParams.get("__dzctx") ?? "";

    const appendDzContextIfNeeded = (target: string) => {
        if (!contextDzId || !target.startsWith(`${PROXY_PATH}/jumper_manifest_public`)) {
            return target;
        }

        if (target.includes("dz_id=") || target.includes("__dzctx=")) {
            return target;
        }

        const separator = target.includes("?") ? "&" : "?";
        return `${target}${separator}__dzctx=${encodeURIComponent(contextDzId)}`;
    };

    try {
        const parsed = new URL(location, request.nextUrl.origin);
        const isUpstreamLocation = parsed.host === upstreamHost;
        const isCurrentHostLocation = parsed.host === request.nextUrl.host;

        if (isUpstreamLocation || isCurrentHostLocation) {
            const rewrittenPath = parsed.pathname.startsWith(PROXY_PATH)
                ? parsed.pathname
                : `${PROXY_PATH}${parsed.pathname}`;

            return appendDzContextIfNeeded(`${rewrittenPath}${parsed.search}${parsed.hash}`);
        }
    } catch {
        // Fall back to string-based rewriting below.
    }

    if (location.startsWith(UPSTREAM_ORIGIN)) {
        return appendDzContextIfNeeded(`${PROXY_PATH}${location.slice(UPSTREAM_ORIGIN.length)}`);
    }

    if (location.startsWith("/")) {
        return appendDzContextIfNeeded(`${PROXY_PATH}${location}`);
    }

    return location;
}

async function handleRequest(
    request: NextRequest,
    context: { params: Promise<{ path: string[] }> },
) {
    const { path } = await context.params;
    const upstreamPath = `/${(path ?? []).join("/")}`;
    const upstreamUrl = new URL(`${UPSTREAM_ORIGIN}${upstreamPath}`);
    upstreamUrl.search = request.nextUrl.search;
    upstreamUrl.searchParams.delete("__dzctx");

    const isManifestRoot = upstreamPath === "/jumper_manifest_public";
    const requestDzId = request.nextUrl.searchParams.get("dz_id");
    const contextDzId = requestDzId ?? request.nextUrl.searchParams.get("__dzctx") ?? "";
    const hasDzId = Boolean(requestDzId);
    const existingDzId = request.cookies.get(ACTIVE_DZ_COOKIE)?.value ?? "";
    const shouldResetSession = hasDzId && requestDzId !== existingDzId;

    const hasDzContext = Boolean(contextDzId) || Boolean(existingDzId);

    if (isManifestRoot && !hasDzContext) {
        const missingDzResponse = new NextResponse("Missing required dz_id query parameter.", {
            status: 400,
            headers: {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                pragma: "no-cache",
                expires: "0",
                "surrogate-control": "no-store",
            },
        });

        request.cookies
            .getAll()
            .filter((cookie) => cookie.name.startsWith(COOKIE_PREFIX))
            .forEach((cookie) => {
                missingDzResponse.cookies.delete(cookie.name);
            });

        return missingDzResponse;
    }

    const headers = new Headers();
    // If the URL contains dz_id, force a fresh Burble session so it correctly
    // associates the session with that DZ only when switching DZs.
    const incomingCookieHeader = shouldResetSession ? "" : buildUpstreamCookieHeader(request);

    request.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();

        if ([
            "host",
            "cookie",
            "content-length",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-forwarded-port",
            "forwarded",
        ].includes(lowerKey)) {
            return;
        }

        headers.set(key, value);
    });

    headers.set("origin", UPSTREAM_ORIGIN);
    headers.set("referer", `${UPSTREAM_ORIGIN}/`);

    if (incomingCookieHeader) {
        headers.set("cookie", incomingCookieHeader);
    }

    const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
        redirect: "manual",
    });

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.delete("content-security-policy");
    responseHeaders.delete("content-security-policy-report-only");
    responseHeaders.delete("x-frame-options");
    responseHeaders.delete("strict-transport-security");
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("set-cookie");
    responseHeaders.set("cache-control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    responseHeaders.set("pragma", "no-cache");
    responseHeaders.set("expires", "0");
    responseHeaders.set("surrogate-control", "no-store");

    const location = upstreamResponse.headers.get("location");
    if (location) {
        responseHeaders.set("location", rewriteLocationHeader(location, request));
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const isTextResponse =
        contentType.startsWith("text/") ||
        contentType.includes("javascript") ||
        contentType.includes("json") ||
        contentType.includes("xml");

    const response = new NextResponse(
        isTextResponse ? rewriteBody(await upstreamResponse.text(), request) : await upstreamResponse.arrayBuffer(),
        {
            status: upstreamResponse.status,
            headers: responseHeaders,
        },
    );

    const setCookieValues =
        typeof upstreamResponse.headers.getSetCookie === "function"
            ? upstreamResponse.headers.getSetCookie()
            : splitSetCookieHeader(upstreamResponse.headers.get("set-cookie") ?? "");
    const shouldUseSecureCookies = request.nextUrl.protocol === "https:";

    // Only clear old proxy cookies when switching to a different DZ.
    if (shouldResetSession) {
        const existingCookies = request.cookies
            .getAll()
            .filter((cookie) => cookie.name.startsWith(COOKIE_PREFIX) && cookie.name !== ACTIVE_DZ_COOKIE);

        if (existingCookies.length > 0) {
            existingCookies.forEach((cookie) => {
                response.cookies.delete(cookie.name);
            });
        }
    }

    if (hasDzId && requestDzId) {
        response.cookies.set({
            name: ACTIVE_DZ_COOKIE,
            value: requestDzId,
            path: "/",
            httpOnly: false,
            secure: false,
            sameSite: "lax",
        });
    }

    setCookieValues
        .filter(Boolean)
        .forEach((setCookieValue) => {
            const parsedCookie = parseSetCookie(setCookieValue);

            if (!parsedCookie) {
                return;
            }

            const expires = parsedCookie.attributes.get("expires");
            const maxAge = parsedCookie.attributes.get("max-age");
            const httpOnly = parsedCookie.attributes.has("httponly");
            const secure = parsedCookie.attributes.has("secure");

            response.cookies.set({
                name: `${COOKIE_PREFIX}${parsedCookie.name}`,
                value: parsedCookie.value,
                path: "/",
                httpOnly,
                secure: shouldUseSecureCookies ? secure : false,
                sameSite: "lax",
                expires: typeof expires === "string" ? new Date(expires) : undefined,
                maxAge: typeof maxAge === "string" ? Number.parseInt(maxAge, 10) : undefined,
            });
        });

    return response;
}

export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
export const HEAD = handleRequest;
export const OPTIONS = handleRequest;
