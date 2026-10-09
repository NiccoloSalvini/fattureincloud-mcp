import { describe, expect, it } from "vitest";
import { FicClient, FicQuotaError } from "../src/client.js";

function fetchWithQuota(remaining: () => number) {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return new Response(JSON.stringify({ data: { companies: [{ id: 1, name: "X" }] } }), {
      status: 200,
      headers: { "RateLimit-HourlyRemaining": String(remaining()), "RateLimit-HourlyLimit": "1000", "RateLimit-MonthlyRemaining": "39000", "RateLimit-MonthlyLimit": "40000" },
    });
  }) as typeof fetch;
  return { impl, calls: () => calls };
}

describe("quota guard", () => {
  it("tracks RateLimit headers and stops before the reserve", async () => {
    let left = 26;
    const f = fetchWithQuota(() => left--);
    const c = new FicClient({ token: "t", fetchImpl: f.impl, quotaReserve: 25 });
    await c.listCompanies();
    expect(c.quota).toMatchObject({ hourly_remaining: 26, hourly_limit: 1000, monthly_remaining: 39000 });
    await c.listCompanies(); // 25 left after this one: at the reserve
    await expect(c.listCompanies()).rejects.toBeInstanceOf(FicQuotaError);
    expect(f.calls()).toBe(2);
  });

  it("shares the counter with clients for other companies", async () => {
    const f = fetchWithQuota(() => 10);
    const c = new FicClient({ token: "t", fetchImpl: f.impl, quotaReserve: 25 });
    await c.listCompanies();
    await expect(c.withCompany(99).get("/products")).rejects.toThrow(/Quota oraria/);
  });
});
