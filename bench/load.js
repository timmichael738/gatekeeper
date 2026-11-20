// k6 load test: https://k6.io — run with `k6 run bench/load.js`
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 50,
    },
  },
  thresholds: {
    // Gateway overhead should stay low even while rejecting most traffic.
    http_req_duration: ['p(95)<50'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8081';

export default function () {
  const res = http.get(`${BASE_URL}/public/`);
  check(res, {
    'is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'has RateLimit headers': (r) => r.headers['Ratelimit-Limit'] !== undefined,
  });
}
