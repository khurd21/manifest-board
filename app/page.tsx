"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type Dropzone = {
  id: string;
  name: string;
  manifestUrl: string;
  latitude: number | null;
  longitude: number | null;
};

type WindPoint = {
  altitudeFt: number;
  speedKt: number;
  directionDeg: number;
};

type OpenMeteoResponse = {
  timezone: string;
  hourly: {
    time: string[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
    wind_speed_1000hPa?: number[];
    wind_direction_1000hPa?: number[];
    wind_speed_950hPa?: number[];
    wind_direction_950hPa?: number[];
    wind_speed_900hPa?: number[];
    wind_direction_900hPa?: number[];
    wind_speed_850hPa?: number[];
    wind_direction_850hPa?: number[];
    wind_speed_800hPa?: number[];
    wind_direction_800hPa?: number[];
    wind_speed_700hPa?: number[];
    wind_direction_700hPa?: number[];
    wind_speed_600hPa?: number[];
    wind_direction_600hPa?: number[];
  };
};

const DROPZONES_JSON_PATH = "/dropzones.json";

const TARGET_ALTITUDES_FT = Array.from({ length: 16 }, (_, index) => index * 1000);

const PRESSURE_LEVELS: Array<{
  altitudeFt: number;
  speedKey: keyof OpenMeteoResponse["hourly"];
  directionKey: keyof OpenMeteoResponse["hourly"];
}> = [
    { altitudeFt: 33, speedKey: "wind_speed_10m", directionKey: "wind_direction_10m" },
    {
      altitudeFt: 364,
      speedKey: "wind_speed_1000hPa",
      directionKey: "wind_direction_1000hPa",
    },
    {
      altitudeFt: 1770,
      speedKey: "wind_speed_950hPa",
      directionKey: "wind_direction_950hPa",
    },
    {
      altitudeFt: 3248,
      speedKey: "wind_speed_900hPa",
      directionKey: "wind_direction_900hPa",
    },
    {
      altitudeFt: 4780,
      speedKey: "wind_speed_850hPa",
      directionKey: "wind_direction_850hPa",
    },
    {
      altitudeFt: 6390,
      speedKey: "wind_speed_800hPa",
      directionKey: "wind_direction_800hPa",
    },
    {
      altitudeFt: 9880,
      speedKey: "wind_speed_700hPa",
      directionKey: "wind_direction_700hPa",
    },
    {
      altitudeFt: 13800,
      speedKey: "wind_speed_600hPa",
      directionKey: "wind_direction_600hPa",
    },
  ];

function getEmbeddedManifestUrl(manifestUrl: string) {
  if (!manifestUrl) {
    return "";
  }

  try {
    const url = new URL(manifestUrl);

    if (url.hostname !== "dzm.burblesoft.com") {
      return manifestUrl;
    }

    return `/burble-proxy${url.pathname}${url.search}${url.hash}`;
  } catch {
    return manifestUrl;
  }
}

function toVector(speedKt: number, directionDeg: number) {
  const radians = (directionDeg * Math.PI) / 180;
  return {
    u: -speedKt * Math.sin(radians),
    v: -speedKt * Math.cos(radians),
  };
}

function fromVector(u: number, v: number) {
  const speedKt = Math.sqrt(u * u + v * v);
  const directionDeg = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  return {
    speedKt,
    directionDeg,
  };
}

function interpolateWind(
  altitudeFt: number,
  lower: WindPoint,
  upper: WindPoint,
): WindPoint {
  if (upper.altitudeFt <= lower.altitudeFt) {
    return lower;
  }

  const ratio = (altitudeFt - lower.altitudeFt) / (upper.altitudeFt - lower.altitudeFt);
  const lowVec = toVector(lower.speedKt, lower.directionDeg);
  const upVec = toVector(upper.speedKt, upper.directionDeg);

  const u = lowVec.u + (upVec.u - lowVec.u) * ratio;
  const v = lowVec.v + (upVec.v - lowVec.v) * ratio;
  const wind = fromVector(u, v);

  return {
    altitudeFt,
    speedKt: wind.speedKt,
    directionDeg: wind.directionDeg,
  };
}

function chooseHourIndex(times: string[]) {
  const now = Date.now();
  let bestIndex = 0;
  let smallestDiff = Number.POSITIVE_INFINITY;

  times.forEach((time, index) => {
    const diff = Math.abs(new Date(time).getTime() - now);
    if (diff < smallestDiff) {
      smallestDiff = diff;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function normalizeHeading(directionDeg: number) {
  return ((directionDeg % 360) + 360) % 360;
}

function formatHeading(directionDeg: number) {
  return `${Math.round(normalizeHeading(directionDeg)).toString().padStart(3, "0")}°`;
}

function getNearestWindPoint(profile: WindPoint[], targetAltitudeFt: number) {
  if (profile.length === 0) {
    return null;
  }

  return profile.reduce((closest, point) => {
    const closestDiff = Math.abs(closest.altitudeFt - targetAltitudeFt);
    const pointDiff = Math.abs(point.altitudeFt - targetAltitudeFt);

    return pointDiff < closestDiff ? point : closest;
  });
}

const MAP_LAT_DELTA = 0.006;

function getMapLonDelta(latitude: number) {
  return MAP_LAT_DELTA / Math.max(Math.cos((latitude * Math.PI) / 180), 0.3);
}

function getMapEmbedUrl(latitude: number, longitude: number) {
  const latDelta = MAP_LAT_DELTA;
  const lonDelta = getMapLonDelta(latitude);
  const bbox = [
    longitude - lonDelta,
    latitude - latDelta,
    longitude + lonDelta,
    latitude + latDelta,
  ].join(",");

  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=1200,800&format=jpg&transparent=false&f=image`;
}

function getArrowGeometry(headingDeg: number, length = 34, tipSize = 3.2) {
  const radians = (normalizeHeading(headingDeg) * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const tipX = 50 + dx * length;
  const tipY = 50 + dy * length;
  const baseX = 50 + dx * (length - 7);
  const baseY = 50 + dy * (length - 7);
  const perpX = -dy;
  const perpY = dx;

  return {
    tipX,
    tipY,
    arrowHeadPoints: `${tipX},${tipY} ${baseX + perpX * tipSize},${baseY + perpY * tipSize} ${baseX - perpX * tipSize},${baseY - perpY * tipSize}`,
  };
}

function getFullLineArrowGeometry(headingDeg: number, length = 46, tipSize = 3.4) {
  const radians = (normalizeHeading(headingDeg) * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const startX = 50 - dx * length;
  const startY = 50 - dy * length;
  const tipX = 50 + dx * length;
  const tipY = 50 + dy * length;
  const baseX = tipX - dx * 7;
  const baseY = tipY - dy * 7;
  const perpX = -dy;
  const perpY = dx;

  return {
    startX,
    startY,
    tipX,
    tipY,
    arrowHeadPoints: `${tipX},${tipY} ${baseX + perpX * tipSize},${baseY + perpY * tipSize} ${baseX - perpX * tipSize},${baseY - perpY * tipSize}`,
  };
}

function milesToMapUnits(miles: number, latitude: number) {
  const lonDelta = getMapLonDelta(latitude);
  const milesAcross = 2 * lonDelta * 69 * Math.cos((latitude * Math.PI) / 180);

  if (!Number.isFinite(milesAcross) || milesAcross <= 0) {
    return 0;
  }

  return (miles / milesAcross) * 100;
}

function getOffsetJumpRunGeometry(
  headingDeg: number,
  latitude: number,
  offsetMiles: number | null,
  offsetMode: "before" | "after" | null,
) {
  const radians = (normalizeHeading(headingDeg) * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const directionSign = offsetMode === "after" ? 1 : -1;
  const shiftUnits = offsetMiles && offsetMiles > 0
    ? milesToMapUnits(offsetMiles, latitude) * directionSign
    : 0;

  const centerX = 50 + dx * shiftUnits;
  const centerY = 50 + dy * shiftUnits;

  const geometry = getFullLineArrowGeometry(headingDeg, 46, 3.4);
  const deltaX = centerX - 50;
  const deltaY = centerY - 50;

  return {
    startX: geometry.startX + deltaX,
    startY: geometry.startY + deltaY,
    tipX: geometry.tipX + deltaX,
    tipY: geometry.tipY + deltaY,
    arrowHeadPoints: geometry.arrowHeadPoints
      .split(" ")
      .map((point) => {
        const [x, y] = point.split(",").map(Number);
        return `${x + deltaX},${y + deltaY}`;
      })
      .join(" "),
  };
}

function getLandingPatternGeometry(
  finalHeadingDeg: number,
  hand: "left" | "right",
) {
  const radians = (normalizeHeading(finalHeadingDeg) * Math.PI) / 180;
  const forwardX = Math.sin(radians);
  const forwardY = -Math.cos(radians);
  const rightX = Math.cos(radians);
  const rightY = Math.sin(radians);
  const sideSign = hand === "right" ? 1 : -1;
  const sideX = rightX * sideSign;
  const sideY = rightY * sideSign;

  const touchdownX = 50;
  const touchdownY = 54;
  const finalLength = 18;
  const baseOffset = 14;
  const downwindLength = 26;

  const finalStartX = touchdownX - forwardX * finalLength;
  const finalStartY = touchdownY - forwardY * finalLength;
  const baseStartX = finalStartX + sideX * baseOffset;
  const baseStartY = finalStartY + sideY * baseOffset;
  const downwindStartX = baseStartX + forwardX * downwindLength;
  const downwindStartY = baseStartY + forwardY * downwindLength;

  const arrowBaseX = touchdownX - forwardX * 6;
  const arrowBaseY = touchdownY - forwardY * 6;
  const perpX = -forwardY;
  const perpY = forwardX;

  return {
    pathPoints: `${downwindStartX},${downwindStartY} ${baseStartX},${baseStartY} ${finalStartX},${finalStartY} ${touchdownX},${touchdownY}`,
    arrowHeadPoints: `${touchdownX},${touchdownY} ${arrowBaseX + perpX * 3.2},${arrowBaseY + perpY * 3.2} ${arrowBaseX - perpX * 3.2},${arrowBaseY - perpY * 3.2}`,
  };
}

export default function Home() {
  const searchParams = useSearchParams();
  const dropzoneIdParam = (searchParams.get("dropzone_id") ?? "").toLowerCase();
  const [dropzones, setDropzones] = useState<Dropzone[]>([]);
  const [dropzonesLoaded, setDropzonesLoaded] = useState(false);
  const [dropzonesError, setDropzonesError] = useState("");
  const [winds, setWinds] = useState<WindPoint[]>([]);
  const [forecastTime, setForecastTime] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const loadDropzones = async () => {
      try {
        setDropzonesError("");

        const response = await fetch(DROPZONES_JSON_PATH, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Could not load dropzone config.");
        }

        const data = (await response.json()) as unknown;
        if (!Array.isArray(data)) {
          throw new Error("Dropzone config must be an array.");
        }

        const normalizedDropzones = data.filter((item): item is Dropzone => {
          if (typeof item !== "object" || item === null) {
            return false;
          }

          const candidate = item as Partial<Dropzone>;

          return (
            typeof candidate.id === "string" &&
            typeof candidate.name === "string" &&
            typeof candidate.manifestUrl === "string" &&
            (typeof candidate.latitude === "number" || candidate.latitude === null) &&
            (typeof candidate.longitude === "number" || candidate.longitude === null)
          );
        });

        if (normalizedDropzones.length === 0) {
          throw new Error("Dropzone config has no valid entries.");
        }

        setDropzones(normalizedDropzones);
      } catch (err) {
        setDropzones([]);
        setDropzonesError(err instanceof Error ? err.message : "Could not load dropzone config.");
      } finally {
        setDropzonesLoaded(true);
      }
    };

    void loadDropzones();
  }, []);

  const selectedDz = useMemo(() => {
    if (!dropzoneIdParam) {
      return null;
    }

    return dropzones.find((dz) => dz.id.toLowerCase() === dropzoneIdParam) ?? null;
  }, [dropzoneIdParam, dropzones]);

  const isInvalidDropzoneParam = useMemo(() => {
    if (!dropzoneIdParam || !dropzonesLoaded || dropzones.length === 0) {
      return false;
    }

    return !dropzones.some((dz) => dz.id.toLowerCase() === dropzoneIdParam);
  }, [dropzoneIdParam, dropzones, dropzonesLoaded]);

  const activeManifestUrl = selectedDz?.manifestUrl ?? "";
  const embeddedManifestUrl = getEmbeddedManifestUrl(activeManifestUrl);

  const activeLatitude = selectedDz?.latitude ?? NaN;
  const activeLongitude = selectedDz?.longitude ?? NaN;

  const mapEmbedUrl = useMemo(() => {
    if (!Number.isFinite(activeLatitude) || !Number.isFinite(activeLongitude)) {
      return "";
    }

    return getMapEmbedUrl(activeLatitude, activeLongitude);
  }, [activeLatitude, activeLongitude]);

  useEffect(() => {
    let timeoutId: number | undefined;
    let disposed = false;

    const refreshIntervalMs = 15 * 60 * 1000;

    const scheduleNextRefresh = () => {
      const now = Date.now();
      const nextBoundary = Math.ceil(now / refreshIntervalMs) * refreshIntervalMs;
      const delayMs = Math.max(1000, nextBoundary - now);

      timeoutId = window.setTimeout(() => {
        setRefreshTick((prev) => prev + 1);

        if (!disposed) {
          scheduleNextRefresh();
        }
      }, delayMs);
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        setRefreshTick((prev) => prev + 1);
      }
    };

    scheduleNextRefresh();
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      disposed = true;

      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }

      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (!Number.isFinite(activeLatitude) || !Number.isFinite(activeLongitude)) {
      setWinds([]);
      setForecastTime("");
      return;
    }

    const controller = new AbortController();

    const loadWinds = async () => {
      setIsLoading(true);
      setError("");

      try {
        const hourlyFields = [
          "wind_speed_10m",
          "wind_direction_10m",
          "wind_speed_1000hPa",
          "wind_direction_1000hPa",
          "wind_speed_950hPa",
          "wind_direction_950hPa",
          "wind_speed_900hPa",
          "wind_direction_900hPa",
          "wind_speed_850hPa",
          "wind_direction_850hPa",
          "wind_speed_800hPa",
          "wind_direction_800hPa",
          "wind_speed_700hPa",
          "wind_direction_700hPa",
          "wind_speed_600hPa",
          "wind_direction_600hPa",
        ].join(",");

        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${activeLatitude}&longitude=${activeLongitude}&hourly=${hourlyFields}&forecast_days=1&timezone=auto&wind_speed_unit=kn&_=${Date.now()}`,
          { signal: controller.signal, cache: "no-store" },
        );

        if (!response.ok) {
          throw new Error("Failed to load wind forecast.");
        }

        const data = (await response.json()) as OpenMeteoResponse;
        const hourIndex = chooseHourIndex(data.hourly.time);

        const availableProfile: WindPoint[] = PRESSURE_LEVELS.map((level) => {
          const speedSeries = data.hourly[level.speedKey] as number[] | undefined;
          const directionSeries = data.hourly[level.directionKey] as number[] | undefined;

          const speedKt = speedSeries?.[hourIndex];
          const directionDeg = directionSeries?.[hourIndex];

          if (typeof speedKt !== "number" || typeof directionDeg !== "number") {
            return null;
          }

          return {
            altitudeFt: level.altitudeFt,
            speedKt,
            directionDeg,
          };
        }).filter((point): point is WindPoint => point !== null);

        if (availableProfile.length < 2) {
          throw new Error("Not enough wind levels returned for this location.");
        }

        const interpolated = TARGET_ALTITUDES_FT.map((altitudeFt) => {
          if (altitudeFt <= availableProfile[0].altitudeFt) {
            return { ...availableProfile[0], altitudeFt };
          }

          if (altitudeFt >= availableProfile[availableProfile.length - 1].altitudeFt) {
            return { ...availableProfile[availableProfile.length - 1], altitudeFt };
          }

          for (let i = 0; i < availableProfile.length - 1; i += 1) {
            const lower = availableProfile[i];
            const upper = availableProfile[i + 1];

            if (altitudeFt >= lower.altitudeFt && altitudeFt <= upper.altitudeFt) {
              return interpolateWind(altitudeFt, lower, upper);
            }
          }

          return { ...availableProfile[availableProfile.length - 1], altitudeFt };
        });

        setWinds(interpolated);
        setForecastTime(new Date(data.hourly.time[hourIndex]).toLocaleString());
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }

        setWinds([]);
        setForecastTime("");
        setError(err instanceof Error ? err.message : "Could not fetch winds aloft.");
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void loadWinds();

    return () => controller.abort();
  }, [activeLatitude, activeLongitude, refreshTick]);

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-100 text-zinc-900">
      <header className="flex shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2">
        <div className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium">
          {selectedDz ? selectedDz.name : "No dropzone selected"}
        </div>

        {selectedDz ? <span className="text-xs text-zinc-500">dropzone_id={selectedDz.id}</span> : null}

        {forecastTime ? <span className="ml-auto text-xs text-zinc-500">Winds: {forecastTime}</span> : null}
      </header>

      <div className="min-h-0 flex flex-1">
        {/* Manifest iframe */}
        <div className="min-h-0 flex-1 bg-zinc-200">
          {activeManifestUrl ? (
            <iframe
              key={embeddedManifestUrl}
              title="Burble manifest"
              src={embeddedManifestUrl}
              className="h-full w-full"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <div className="max-w-xl rounded-lg border border-zinc-300 bg-white p-5 text-center">
                <p className="text-base font-semibold text-zinc-800">
                  {isInvalidDropzoneParam ? "Incorrect dropzone_id" : "No dropzone_id specified"}
                </p>

                <p className="mt-1 text-sm text-zinc-600">
                  Use one of the supported dropzone IDs:
                </p>

                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {dropzones.map((dz) => (
                    <a
                      key={dz.id}
                      href={`?dropzone_id=${encodeURIComponent(dz.id)}`}
                      className="rounded border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100"
                    >
                      {dz.id}
                    </a>
                  ))}
                </div>

                {dropzonesError ? (
                  <p className="mt-3 text-xs font-medium text-amber-700">{dropzonesError}</p>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {/* Winds + map */}
        <aside className="flex w-[360px] shrink-0 flex-col border-l border-zinc-200 bg-white">
          <div className="border-b border-zinc-200 px-3 py-2">
            <p className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Winds Aloft</p>
            {isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
            {error ? <p className="text-sm text-red-500">{error}</p> : null}
          </div>

          <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
            <section className="border-b border-zinc-200 p-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-zinc-800">DZ Map</p>
                {Number.isFinite(activeLatitude) && Number.isFinite(activeLongitude) ? (
                  <span className="text-[11px] text-zinc-500">
                    {activeLatitude.toFixed(3)}, {activeLongitude.toFixed(3)}
                  </span>
                ) : null}
              </div>

              {mapEmbedUrl ? (
                <>
                  <div className="relative overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100">
                    <img
                      alt="DZ satellite map"
                      src={mapEmbedUrl}
                      className="h-[132px] w-full object-cover"
                    />

                    <div className="pointer-events-none absolute inset-0 bg-white/5" />

                    <svg
                      viewBox="0 0 100 100"
                      className="pointer-events-none absolute inset-0 h-full w-full"
                      aria-hidden="true"
                    >
                      <circle cx="50" cy="50" r="2" fill="#18181b" opacity="0.9" />
                    </svg>

                    <div className="pointer-events-none absolute right-2 top-2 flex h-10 w-10 items-center justify-center rounded-full border border-zinc-300 bg-white/90 text-[7px] text-zinc-700 shadow-sm">
                      <div className="absolute inset-2 rounded-full border border-zinc-300" />
                      <div className="absolute inset-x-2.5 top-1/2 h-px -translate-y-1/2 bg-zinc-300" />
                      <div className="absolute inset-y-2.5 left-1/2 w-px -translate-x-1/2 bg-zinc-300" />
                      <span className="absolute top-0 text-[6px] font-semibold">N</span>
                      <span className="absolute right-0 text-[6px] font-semibold">E</span>
                      <span className="absolute bottom-0 text-[6px] font-semibold">S</span>
                      <span className="absolute left-0 text-[6px] font-semibold">W</span>
                    </div>

                    <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-white/90 px-2 py-1 text-[10px] font-medium text-zinc-700 shadow-sm">
                      {selectedDz?.name ?? "No DZ selected"}
                    </div>
                  </div>

                </>
              ) : (
                <div className="flex h-[132px] items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-center text-sm text-zinc-500">
                  No coordinates available for this DZ map.
                </div>
              )}
            </section>

            {!isLoading && !error && winds.length > 0 ? (
              <div className="relative min-h-0 flex-1 px-3 py-1.5">
                <div className="pointer-events-none absolute bottom-1.5 left-[112px] top-1.5 w-px bg-zinc-300" />

                <div className="relative flex h-full flex-col justify-between">
                  {[...winds].reverse().map((wind) => (
                    <div key={wind.altitudeFt} className="grid grid-cols-[72px_28px_1fr] items-center gap-3">
                      <span className="text-right text-sm font-semibold text-zinc-700">
                        {wind.altitudeFt === 0 ? "SFC" : `${wind.altitudeFt / 1000}k`}
                      </span>

                      <div
                        className="relative z-10 flex h-7 w-7 items-center justify-center rounded-full bg-white ring-2 ring-zinc-400 text-base leading-none text-zinc-700"
                        style={{ transform: `rotate(${wind.directionDeg}deg)` }}
                        title={`${Math.round(wind.speedKt)} kt from ${Math.round(wind.directionDeg)}°`}
                      >
                        ↑
                      </div>

                      <span className="text-sm font-semibold text-zinc-800">
                        {Math.round(wind.speedKt)}kt · {Math.round(wind.directionDeg)}°
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </main>
  );
}
