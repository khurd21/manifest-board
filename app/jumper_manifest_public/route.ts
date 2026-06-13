import { NextRequest, NextResponse } from "next/server";

function buildProxyPath(request: NextRequest) {
    const url = new URL(request.url);
    return `/burble-proxy/jumper_manifest_public${url.search}`;
}

function redirectToProxy(request: NextRequest) {
    return new NextResponse(null, {
        status: 307,
        headers: {
            location: buildProxyPath(request),
        },
    });
}

export const GET = redirectToProxy;
export const POST = redirectToProxy;
export const PUT = redirectToProxy;
export const PATCH = redirectToProxy;
export const DELETE = redirectToProxy;
export const HEAD = redirectToProxy;
export const OPTIONS = redirectToProxy;
