import { afterEach, describe, expect, it } from "vitest";
import {
  jobTimezone,
  scheduleTimezoneOptions,
  SCHEDULE_TIMEZONE_CHOICES,
  systemTimezone
} from "./components/SupportPanel";
import { applyLocale, t } from "./i18n";
import type { ScheduledJob } from "./types";

afterEach(() => applyLocale("zh"));

const job = (timezone?: unknown): ScheduledJob => ({
  id: "job-1",
  name: "每日申请计划",
  ...(timezone === undefined ? {} : { timezone })
});

describe("scheduled job time zones", () => {
  it("offers the system zone first and never repeats a zone", () => {
    const options = scheduleTimezoneOptions("Asia/Shanghai", "America/Chicago");
    expect(options[0]).toBe("America/Chicago");
    expect(options).toEqual([...new Set(options)]);
    expect(options).toEqual(expect.arrayContaining([...SCHEDULE_TIMEZONE_CHOICES]));
  });

  it("keeps a stored zone that is not one of the offered choices", () => {
    const options = scheduleTimezoneOptions("Pacific/Auckland", "Asia/Shanghai");
    expect(options[0]).toBe("Asia/Shanghai");
    expect(options.at(-1)).toBe("Pacific/Auckland");
    expect(scheduleTimezoneOptions("Asia/Shanghai", "Asia/Shanghai")[0]).toBe("Asia/Shanghai");
  });

  it("falls back to the default zone for a job saved before time zones were editable", () => {
    expect(jobTimezone(job())).toBe("Asia/Shanghai");
    expect(jobTimezone(job(""))).toBe("Asia/Shanghai");
    expect(jobTimezone(job(42))).toBe("Asia/Shanghai");
    expect(jobTimezone(job("America/New_York"))).toBe("America/New_York");
    expect(systemTimezone()).toBeTruthy();
  });

  it("labels the system option in both languages", () => {
    expect(t("scheduleTimezoneSystem", { zone: "America/Chicago" })).toBe("本机时区（America/Chicago）");
    applyLocale("en");
    expect(t("scheduleTimezone")).toBe("Time zone");
    expect(t("scheduleTimezoneSystem", { zone: "America/Chicago" })).toBe("This machine (America/Chicago)");
  });
});
