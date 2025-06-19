import { initialConfig } from "@/config/server";
import { HTTP_TIMEOUT } from "@/constants/timeouts";
import axios from "axios";
import { BaseConfig, Config, Data } from "@/types/types";

type Token = {
  token: string;
  date: Date;
};
const authTokenMap: Map<String, Token> = new Map<String, Token>();
let lastValidToken: string | null = null;

function getUserAgent(cfg: BaseConfig): string {
  return (
    cfg.userAgent ??
    `Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) ${cfg.stbType} stbapp ver:2 rev: 250 Safari/533.3`
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

const PROFILE_VALIDATION_TIMEOUT = 10000; // 10 seconds
const RATE_LIMIT_TIMEOUT = 1000; // 5 seconds
let lastRateLimitHit = 0;

const MAX_RETRIES = 0;
const RETRY_DELAY = 2000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryOperation<T>(
  operation: () => Promise<T>,
  retries: number = MAX_RETRIES
): Promise<T> {
  try {
    // const currentTime = Date.now();
    // if (currentTime - lastRateLimitHit < RATE_LIMIT_TIMEOUT) {
    //   throw new Error("Rate limit cooling down. Please wait.");
    // }
    return await operation();
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 429) {
      lastRateLimitHit = Date.now();
      console.warn("Rate limit exceeded, cooling down for 5 seconds");
      throw new Error("Rate limit exceeded. Please wait.");
    }
    if (retries > 0) {
      await delay(RETRY_DELAY);
      console.debug(`Retrying operation. ${retries - 1} attempts remaining`);
      return retryOperation(operation, retries - 1);
    }
    throw error;
  }
}

const lastProfileValidation: Map<string, number> = new Map();

async function validateProfile(
  token: string,
  cfg: Config,
  headers: { [key: string]: string }
): Promise<string> {
  const validationKey = `${cfg.hostname}${cfg.port}${cfg.mac}`;
  const lastValidation = lastProfileValidation.get(validationKey) || 0;
  const currentTime = Date.now();

  // if (currentTime - lastValidation < PROFILE_VALIDATION_TIMEOUT) {
  //   return token;
  // }

  const profileHeaders = {
    ...headers,
    Authorization: `Bearer ${token}`,
    SN: cfg.serialNumber!,
  };
  const profileUrl = `/server/load.php?type=stb&action=get_profile&hd=1&auth_second_step=0&num_banks=1&stb_type=${
    cfg.stbType
  }&image_version=&hw_version=&not_valid_token=0&device_id=${
    cfg.deviceId1
  }&device_id2=${cfg.deviceId2}&signature=&sn=${cfg.serialNumber!}&ver=`;

  try {
    await fetchData<Data<any>>(
      profileUrl,
      false,
      profileHeaders,
      token,
      cfg,
      true
    );
    lastProfileValidation.set(validationKey, currentTime);
    return token;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Rate limit")) {
      console.warn("Profile validation skipped due to rate limit");
      return token;
    }
    throw error;
  }
}

async function getToken(
  refresh: boolean = false,
  cfg: Config = initialConfig
): Promise<string> {
  const tokenKey: string = `${cfg.hostname}${cfg.port}${cfg.contextPath}${cfg.mac}`;
  const tokenCacheDuration = initialConfig.tokenCacheDuration ?? 6000;

  if (!refresh && isTokenValid(tokenKey, tokenCacheDuration)) {
    console.debug(`Using cached token for ${cfg.hostname}`);
    return authTokenMap.get(tokenKey)!.token;
  }

  const headers = {
    Accept: "application/json",
    "User-Agent": getUserAgent(cfg),
    "X-User-Agent": getUserAgent(cfg),
    Cookie: `mac=${cfg.mac}; stb_lang=en`,
  };

  try {
    const data = await fetchData<Data<{ token: string }>>(
      "/server/load.php?type=stb&action=handshake",
      false,
      headers,
      "",
      cfg
    );

    if (!data?.js?.token) throw new Error("Invalid token response");

    const token = data.js.token;
    authTokenMap.set(tokenKey, { token, date: new Date() });
    console.debug(`Token cached for ${cfg.hostname}`);
    return token;
  } catch (error) {
    console.log(error);

    console.error(
      `Failed to get token for ${cfg.hostname}: ${
        error instanceof Error ? error.message : error
      }`
    );
    throw error;
  }
}

export async function fetchData<T>(
  path: string,
  ignoreError: boolean = false,
  headers: { [key: string]: string } = {},
  token: string = "",
  cfg: Config = initialConfig,
  isProfileCheck: boolean = false
): Promise<T> {
  return retryOperation(async () => {
    const completePath =
      (!!cfg.contextPath ? "/" + cfg.contextPath : "") + path;
    console.debug(
      `Initiating request to ${cfg.hostname}:${cfg.port}${completePath}`
    );
    const currentTime = Date.now();
    if (currentTime - lastRateLimitHit < RATE_LIMIT_TIMEOUT) {
      // await delay(2000)
      return {} as T
    }

    const headersProvided: boolean = Object.keys(headers).length !== 0;

    if (!headersProvided) {
      token = lastValidToken || (await getToken(false, cfg));
      lastValidToken = token;
      headers = {
        Accept: "application/json",
        "User-Agent": getUserAgent(cfg),
        "X-User-Agent": getUserAgent(cfg),
        Cookie: `mac=${cfg.mac}; stb_lang=en`,
        Authorization: token ? `Bearer ${token}` : "",
        SN: cfg.serialNumber!,
      };
    }

    try {
      await delay(500);
      let response = await axios.get<T>(
        `http://${cfg.hostname}:${cfg.port}${completePath}`,
        {
          headers,
          timeout: HTTP_TIMEOUT,
          validateStatus: (status) => status === 200,
        }
      );

      if (
        response.data === "Authorization failed." &&
        !isProfileCheck &&
        !(currentTime - lastRateLimitHit < RATE_LIMIT_TIMEOUT)
      ) {
        await validateProfile(token, cfg, headers);
        response = await axios.get<T>(
          `http://${cfg.hostname}:${cfg.port}${completePath}`,
          {
            headers,
            timeout: HTTP_TIMEOUT,
            validateStatus: (status) => status === 200,
          }
        );
      }

      console.debug(
        `Completed request to ${cfg.hostname}:${cfg.port}${completePath}`
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (
          error.response?.status === 401 ||
          error.response?.data === "Authorization failed."
        ) {
          await delay(500);
          const newToken = await getToken(true, cfg);
          lastValidToken = newToken;
          headers["Authorization"] = `Bearer ${newToken}`;
          return fetchData<T>(path, ignoreError, headers, newToken, cfg);
        }
        if (error.response?.status === 429) {
          lastRateLimitHit = Date.now();
          console.warn("Rate limit hit");

          if (ignoreError) return {} as T;
          throw new Error("Rate limit exceeded. Please wait.");
        }

        console.error(
          `Request failed for ${cfg.hostname}:${completePath} : ${error.message}`
        );

        if (ignoreError) return {} as T;
        throw new Error(`HTTP ${error.response?.status}: ${error.message}`);
      }

      if (ignoreError) return {} as T;
      throw error;
    }
  });
}
