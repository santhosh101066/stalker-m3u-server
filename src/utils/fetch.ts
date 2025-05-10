import { config, serverConfig } from "@/config/server";
import { HTTP_TIMEOUT } from "@/constants/timeouts";
import {http} from "follow-redirects"
import { BaseConfig, Config, Data } from "@/types/types";
import {
    catchError,
    finalize,
    firstValueFrom,
    forkJoin,
    from,
    last,
    map,
    Observable,
    of,
    scan,
    switchMap,
    takeWhile,
    tap
} from 'rxjs';

type Token = {
    token: string;
    date: Date;
}
const authTokenMap: Map<String, Token> = new Map<String, Token>();

function getUserAgent(cfg: BaseConfig): string {
    return cfg.userAgent ?? "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG270 stbapp ver:2 rev: 250 Safari/533.3";
}

function getToken(refresh: boolean = false, cfg: Config = config): Observable<string> {
    const tokenKey: string = cfg.hostname + cfg.port + cfg.contextPath + cfg.mac;
    const tokenCacheDuration = config.tokenCacheDuration ?? 5;

    if (!refresh && authTokenMap.has(tokenKey)) {

        const diffSeconds: number = Math.abs((new Date().getTime() - authTokenMap.get(tokenKey)!.date.getTime()) / 1000);
        if (diffSeconds > tokenCacheDuration) {
            // console.debug(chalk.blueBright(`Removed cached token for http://${cfg.hostname}:${cfg.port}${cfg.contextPath ? '/' + cfg.contextPath : ''} [${cfg.mac}]`));
            authTokenMap.delete(tokenKey);
        } else {
            // Get token from map if found
            return of(authTokenMap.get(tokenKey)!.token);
        }
    }

    // Fetch a new token
    return from(fetchData<Data<{ token: string }>>('/server/load.php?type=stb&action=handshake', false,
        {
            'Accept': 'application/json',
            'User-Agent': getUserAgent(cfg),
            'X-User-Agent':  getUserAgent(cfg),
            'Cookie': `mac=${cfg.mac}; stb_lang=en`,
        }, '', cfg))
        .pipe(
            map(data => data?.js?.token),
            switchMap((token: string) => {
                return from(fetchData<Data<any>>(`/server/load.php?type=stb&action=get_profile&hd=1&auth_second_step=0&num_banks=1&stb_type=MAG270&image_version=&hw_version=&not_valid_token=0&device_id=${cfg.deviceId1}&device_id2=${cfg.deviceId2}&signature=&sn=${cfg.serialNumber!}&ver=`, false,
                    {
                        'Accept': 'application/json',
                        'User-Agent': getUserAgent(cfg),
                        'X-User-Agent':   getUserAgent(cfg),
                        'Cookie': `mac=${cfg.mac}; stb_lang=en`,
                        'Authorization': `Bearer ${token}`,
                        'SN': cfg.serialNumber!
                    }, '', cfg)).pipe(
                    map(x => token),
                    tap(x => {
                        console.debug(`Fetched token for http://${cfg.hostname}:${cfg.port}${cfg.contextPath ? '/' + cfg.contextPath : ''} [${cfg.mac}] (renewed in ${tokenCacheDuration} seconds)`);
                        return authTokenMap.set(tokenKey, {token: token, date: new Date()});
                    })
                )
            })
        );
}

export function fetchData<T>(path: string, ignoreError: boolean = false, headers: {
    [key: string]: string
} = {}, token: string = '', cfg: Config = config): Promise<T> {

    return new Promise<T>((resp, err) => {

        const completePath = (!!cfg.contextPath ? '/' + cfg.contextPath : '') + path;

        const onError: (e: any) => void
            = (e) => {
            console.error(`Error at http://${cfg.hostname}:${cfg.port}${completePath} [${cfg.mac}] (ignore: ${ignoreError})`);
            if (ignoreError) {
                resp(<T>{});
            } else {
                err(e);
            }
        };

        let token$: Observable<string>;
        const headersProvided: boolean = Object.keys(headers).length !== 0;
        if (!headersProvided) {
            token$ = getToken(false, cfg);
        } else {
            token$ = of(token);
        }

        token$
            .subscribe((token) => {
                // console.debug((!!config.contextPath ? '/' + config.contextPath : '') + path);
                try {

                    if (!headersProvided) {
                        headers = {
                            'Accept': 'application/json',
                            'User-Agent': getUserAgent(cfg),
                            'X-User-Agent': getUserAgent(cfg),
                            'Cookie': `mac=${cfg.mac}; stb_lang=en`,
                            'SN': cfg.serialNumber!
                        };
                        if (!!token) {
                            headers['Authorization'] = `Bearer ${token}`;
                        }
                    }

                    const req = http.get({
                        hostname: cfg.hostname,
                        port: cfg.port,
                        path: completePath,
                        method: 'GET',
                        headers: headers,
                        timeout: HTTP_TIMEOUT
                    }, (res: any) => {

                        if (res.statusCode !== 200) {
                            console.error(`Did not get an OK from the server (http://${cfg.hostname}:${cfg.port}${completePath} [${cfg.mac}]). Code: ${res.statusCode}`);
                            res.resume();
                            err();
                        }

                        let data = '';

                        res.on('data', (chunk: any) => {
                            try {
                                data += chunk;
                            } catch (error) {
                                // console.error('on data error', error);
                            }
                        });

                        res.on('close', () => {
                            // console.debug(`Retrieved data (${data.length} bytes)`);
                            try {
                                resp(JSON.parse(!!data ? data : '{}'));
                            } catch (e) {
                                //console.error(`Wrong JSON data received: '${data}'`);
                                console.debug(data);
                                err(e);
                            }
                        });

                        res.on('error', (e: NodeJS.ErrnoException) => {
                            console.error(`Response stream error: ${e?.message}`);
                            onError(e);
                        });

                        res.on('end', () => {
                            //console.log('No more data in response.');
                        });
                    }, (e: any) => {
                        onError(e);
                    });

                    // Catch errors on the request

                    req.on('timeout', () => {
                        try {
                            onError(`Request timed out after ${HTTP_TIMEOUT} ms`);
                        } finally {
                            // Close the request to prevent leaks
                            req.destroy();
                        }
                    });

                    req.on('error', (e: NodeJS.ErrnoException) => {
                        if (e.code === 'ECONNRESET') {
                            console.error('Connection was reset by the remote host.');
                        } else {
                            console.error(`Request error: ${e.message}`);
                        }

                        onError(e);
                    });

                    req.end();

                } catch (e) {
                    onError(e);
                }
            }, onError);
    });
}