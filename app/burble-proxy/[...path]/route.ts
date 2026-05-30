import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_ORIGIN = "https://dzm.burblesoft.com";
const COOKIE_PREFIX = "burble_proxy__";
const PROXY_PATH = "/burble-proxy";

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

function rewriteBody(body: string) {
    // Plain URL replacements (HTML attributes, JS string literals)
    let result = body
        .replaceAll("https://dzm.burblesoft.com/", `${PROXY_PATH}/`)
        .replaceAll("http://dzm.burblesoft.com/", `${PROXY_PATH}/`)
        .replaceAll("//dzm.burblesoft.com/", `${PROXY_PATH}/`)
        .replaceAll("https://dzm.burblesoft.com", PROXY_PATH)
        .replaceAll("http://dzm.burblesoft.com", PROXY_PATH)
        .replaceAll("//dzm.burblesoft.com", PROXY_PATH);

    // JSON-escaped URL replacements (e.g. "baseUrl":"https:\/\/dzm.burblesoft.com\/")
    result = result
        .replaceAll("https:\\/\\/dzm.burblesoft.com\\/", `${PROXY_PATH}\\/`)
        .replaceAll("http:\\/\\/dzm.burblesoft.com\\/", `${PROXY_PATH}\\/`)
        .replaceAll("https:\\/\\/dzm.burblesoft.com", PROXY_PATH)
        .replaceAll("http:\\/\\/dzm.burblesoft.com", PROXY_PATH);

    return result;
}

function rewriteLocationHeader(location: string, request: NextRequest) {
    if (location.startsWith(UPSTREAM_ORIGIN)) {
        return `${PROXY_PATH}${location.slice(UPSTREAM_ORIGIN.length)}`;
    }

    if (location.startsWith("/")) {
        return `${PROXY_PATH}${location}`;
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

    const headers = new Headers();
    // If the URL contains dz_id, force a fresh Burble session so it correctly
    // associates the session with that DZ. Otherwise reuse the existing session.
    const hasDzId = upstreamUrl.searchParams.has("dz_id");
    const incomingCookieHeader = hasDzId ? "" : buildUpstreamCookieHeader(request);

    request.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();

        if (["host", "cookie", "content-length"].includes(lowerKey)) {
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
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("set-cookie");

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
        isTextResponse ? rewriteBody(await upstreamResponse.text()) : await upstreamResponse.arrayBuffer(),
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
