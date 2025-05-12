import { initialConfig } from "@/config/server";
import { HTTP_TIMEOUT } from "@/constants/timeouts";
import { http } from "follow-redirects";
import { BaseConfig, Config, Data } from "@/types/types";
import {
  catchError,
  firstValueFrom,
  from,
  map,
  Observable,
  of,
  switchMap,
  tap,
  retry,
  timer,
} from "rxjs";

type Token = {
  token: string;
  date: Date;
};
const authTokenMap: Map<String, Token> = new Map<String, Token>();

function getUserAgent(cfg: BaseConfig): string {
  return (
    cfg.userAgent ??
    "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG270 stbapp ver:2 rev: 250 Safari/533.3"
  );
}

function isTokenValid(tokenKey: string, tokenCacheDuration: number): boolean {
  if (!authTokenMap.has(tokenKey)) return false;

  const token = authTokenMap.get(tokenKey)!;
  const diffSeconds = Math.abs(
    (new Date().getTime() - token.date.getTime()) / 1000
  );
  return diffSeconds <= tokenCacheDuration;
}

function validateProfile(
  token: string,
  cfg: Config,
  headers: { [key: string]: string }
): Observable<string> {
  const profileHeaders = {
    ...headers,
    Authorization: `Bearer ${token}`,
    SN: cfg.serialNumber!,
  };
  const profileUrl = `/server/load.php?type=stb&action=get_profile&hd=1&auth_second_step=0&num_banks=1&stb_type=MAG270&image_version=&hw_version=&not_valid_token=0&device_id=${
    cfg.deviceId1
  }&device_id2=${cfg.deviceId2}&signature=&sn=${cfg.serialNumber!}&ver=`;

  return from(
    fetchData<Data<any>>(profileUrl, false, profileHeaders, token, cfg, true)
  ).pipe(map(() => token));
}

function getToken(
  refresh: boolean = false,
  cfg: Config = initialConfig
): Observable<string> {
  const tokenKey: string = `${cfg.hostname}${cfg.port}${cfg.contextPath}${cfg.mac}`;
  const tokenCacheDuration = initialConfig.tokenCacheDuration ?? 6000;

  if (!refresh && isTokenValid(tokenKey, tokenCacheDuration)) {
    console.debug(`Using cached token for ${cfg.hostname}`);
    return of(authTokenMap.get(tokenKey)!.token);
  }

  const headers = {
    Accept: "application/json",
    "User-Agent": getUserAgent(cfg),
    "X-User-Agent": getUserAgent(cfg),
    Cookie: `mac=${cfg.mac}; stb_lang=en`,
  };

  return from(
    fetchData<Data<{ token: string }>>(
      "/server/load.php?type=stb&action=handshake",
      false,
      headers,
      "",
      cfg,
      true
    )
  ).pipe(
    map((data) => {
      if (!data?.js?.token) throw new Error("Invalid token response");
      return data.js.token;
    }),
    tap((token) => {
      authTokenMap.set(tokenKey, { token, date: new Date() });
      console.debug(`Token cached for ${cfg.hostname}`);
    }),
    retry({
      count: 3,
      resetOnSuccess: true,
      delay: 2000,
    }),
    catchError((error) => {
      console.error(
        `Failed to get token for ${cfg.hostname}: ${error.message}`
      );
      throw error;
    })
  );
}

export function fetchData<T>(
  path: string,
  ignoreError: boolean = false,
  headers: { [key: string]: string } = {},
  token: string = "",
  cfg: Config = initialConfig,
  skipProfileCheck: boolean = false
): Promise<T> {
  const completePath = (!!cfg.contextPath ? "/" + cfg.contextPath : "") + path;
  console.debug(
    `Initiating request to ${cfg.hostname}:${cfg.port}${completePath}`
  );
  const headersProvided: boolean = Object.keys(headers).length !== 0;

  const token$ = headersProvided ? of(token) : getToken(false, cfg);

  return firstValueFrom(
    token$.pipe(
      map((token) => {
        if (!headersProvided) {
          headers = {
            Accept: "application/json",
            "User-Agent": getUserAgent(cfg),
            "X-User-Agent": getUserAgent(cfg),
            Cookie: `mac=${cfg.mac}; stb_lang=en`,
            Authorization: token ? `Bearer ${token}` : "",
            SN: cfg.serialNumber!,
          };
        }
        return { token, headers };
      }),
      switchMap(({ token, headers }) =>
        skipProfileCheck
          ? of(headers)
          : validateProfile(token, cfg, headers).pipe(map(() => headers))
      ),
      switchMap(
        (headers) =>
          new Observable<T>((observer) => {
            const req = http.get(
              {
                hostname: cfg.hostname,
                port: cfg.port,
                path: completePath,
                method: "GET",
                headers: headers,
                timeout: HTTP_TIMEOUT,
              },
              (res: any) => {
                console.debug(
                  `Received response from ${cfg.hostname}:${cfg.port}${completePath} (status: ${res.statusCode})`
                );
                if (res.statusCode !== 200) {
                  observer.error(
                    new Error(
                      `HTTP ${res.statusCode}: Did not get an OK from the server`
                    )
                  );
                  res.resume();
                  return;
                }

                let data = "";
                res.on("data", (chunk: any) => {
                  try {
                    data += chunk;
                  } catch (error: unknown) {
                    console.error(
                      `Error processing chunk from ${cfg.hostname}: ${
                        error instanceof Error ? error.message : error
                      }`
                    );
                    observer.error(error);
                  }
                });

                res.on("close", () => {
                  console.debug(
                    `Completed request to ${cfg.hostname}:${cfg.port}${completePath}`
                  );
                  try {
                    try {
                      if (data === "Authorization failed.") {
                        timer(500)
                          .pipe(
                            switchMap(() => getToken(true, cfg)),
                            switchMap((newToken) => {
                              headers["Authorization"] = `Bearer ${newToken}`;
                              return fetchData<T>(
                                path,
                                ignoreError,
                                headers,
                                newToken,
                                cfg
                              );
                            })
                          )
                          .subscribe({
                            next: (result) => {
                              observer.next(result);
                              observer.complete();
                            },
                            error: (e) => observer.error(e),
                          });
                        return;
                      }
                      const parsedData = JSON.parse(data || "{}");
                      observer.next(parsedData);
                    } catch (jsonError) {
                      observer.next(data as unknown as T);
                    }
                    observer.complete();
                  } catch (e) {
                    console.error(`Failed to handle response data: ${data}`);
                    observer.error(e);
                  }
                });

                res.on("error", (e: NodeJS.ErrnoException) => {
                  observer.error(e);
                });
              }
            );

            req.on("timeout", () => {
              console.warn(
                `Request timeout for ${cfg.hostname}:${cfg.port}${completePath}`
              );
              req.destroy();
              observer.error(
                new Error(`Request timed out after ${HTTP_TIMEOUT} ms`)
              );
            });

            req.on("error", (e: NodeJS.ErrnoException) => {
              console.error(`Network error for ${cfg.hostname}: ${e.message}`);
              observer.error(e);
            });

            req.end();

            return () => {
              req.destroy();
            };
          })
      ),
      catchError((error) => {
        if (
          error?.message === "Authorization failed." ||
          error?.message?.includes("not_valid_token")
        ) {
          return timer(500).pipe(
            switchMap(() => getToken(true, cfg)),
            switchMap((newToken) =>
              fetchData<T>(path, ignoreError, headers, newToken, cfg)
            )
          );
        }
        if (ignoreError) return of({} as T);
        throw error;
      }),
      retry({
        count: 2,
        delay: (error, retryCount) => {
          if (error?.message?.includes("Timeout")) {
            console.warn(
              `Retrying (${retryCount}) after timeout for ${cfg.hostname}`
            );
          }
          return timer(2000);
        },
      })
    )
  );
}
