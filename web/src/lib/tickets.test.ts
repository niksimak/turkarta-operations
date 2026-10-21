import { describe, expect, it } from "vitest";
import { listPath, segmentLabel } from "./tickets";

describe("tickets", () => {
  it("segmentLabel builds the exact marks", () => {
    expect(segmentLabel({ segment: "business_owner", org_name: "Travelata" })).toBe("Владелец · Travelata");
    expect(segmentLabel({ segment: "business_admin", org_name: "Travelata" })).toBe("Администратор · Travelata");
    expect(segmentLabel({ segment: "corporate_employee", org_name: "Travelata" })).toBe("Корпоративная карта · Travelata");
    expect(segmentLabel({ segment: "partner", org_name: "Агентство" })).toBe("Партнер · Агентство");
    expect(segmentLabel({ segment: "retail", org_name: null })).toBe("Клиент приложения");
    expect(segmentLabel({ segment: "business_owner", org_name: null })).toBe("Владелец");
    expect(segmentLabel({ segment: null, org_name: "Travelata" })).toBeNull();
    expect(listPath({ view: "all", segment: "partner" })).toContain("segment=partner");
  });
});
