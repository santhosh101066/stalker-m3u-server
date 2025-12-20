import axios, { AxiosInstance, AxiosError } from 'axios';
import http from 'http';
import https from 'https';
import { appConfig } from '@/config/server';
import { logger } from '@/utils/logger';

// Create agents with keepAlive enabled for connection reuse
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const httpClient: AxiosInstance = axios.create({
    httpAgent,
    httpsAgent,
    timeout: appConfig.api.timeout,
    // Treat 429 as an error to trigger the retry interceptor.
    // Allow other statuses (like 404, 403) to pass through as success for manual handling.
    validateStatus: (status) => status !== 429,
});

// Retry configuration
const MAX_RETRIES = appConfig.api.retries;
const RETRY_DELAY = 1000; // Start with 1s

httpClient.interceptors.response.use(
    (response) => {
        return response;
    },
    async (error: AxiosError) => {
        const config = error.config as any;

        // If no config or retries exhausted, reject
        if (!config || config.__retryCount >= MAX_RETRIES) {
            return Promise.reject(error);
        }

        // Check if we should retry (429 or network errors)
        const shouldRetry =
            error.response?.status === 429 ||
            !error.response; // Network error

        if (shouldRetry) {
            config.__retryCount = (config.__retryCount || 0) + 1;

            // Exponential backoff: 1s, 2s, 4s...
            let delay = RETRY_DELAY * Math.pow(2, config.__retryCount - 1);

            // Special handling for 429: Random delay between 10s and 30s
            if (error.response?.status === 429) {
                delay = Math.floor(Math.random() * (30000 - 10000 + 1) + 10000);
            }

            const errorMessage = error.response
                ? `Status ${error.response.status}`
                : error.message;

            logger.warn(`[HttpClient] Request failed: ${errorMessage}. Retrying (${config.__retryCount}/${MAX_RETRIES}) in ${delay}ms...`);

            await new Promise((resolve) => setTimeout(resolve, delay));

            return httpClient(config);
        }

        return Promise.reject(error);
    }
);

export { httpClient };
