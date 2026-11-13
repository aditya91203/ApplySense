import { describe, expect, it } from "vitest";
import { chooseOption, matchProfile, PROTECTED, norm } from "../src/shared/profileMatch";
import { EMPTY_PROFILE, type Profile } from "../src/shared/storage";

const profile: Profile = {
  ...EMPTY_PROFILE,
  fullName: "Aditya Achuthan",
  email: "a@example.com",
  phone: "+91 90000 00000",
  expectedCTC: "",
  skillYears: "C#: 1.5\n.NET: 1.5\nReact: 1",
  relocate: "Yes",
};

describe("matchProfile", () => {
  it("matches common identity questions", () => {
    expect(matchProfile("Email address *", profile)).toEqual({ key: "email", value: "a@example.com" });
    expect(matchProfile("First name", profile)?.value).toBe("Aditya");
    expect(matchProfile("Last Name", profile)?.value).toBe("Achuthan");
    expect(matchProfile("Mobile number", profile)?.key).toBe("phone");
  });

  it("returns null value, never a guess, when the profile is blank", () => {
    expect(matchProfile("Expected CTC (LPA)", profile)).toEqual({ key: "expectedCTC", value: null });
    expect(matchProfile("Notice period", profile)?.value).toBeNull();
  });

  it("distinguishes current from expected CTC", () => {
    expect(matchProfile("Current CTC", profile)?.key).toBe("currentCTC");
    expect(matchProfile("Expected salary", profile)?.key).toBe("expectedCTC");
  });

  it("answers per-skill experience only for listed skills", () => {
    expect(matchProfile("How many years of experience do you have with .NET?", profile)?.value).toBe("1.5");
    expect(matchProfile("Years of experience in Kubernetes", profile)).toEqual({ key: "skillYears", value: null });
  });

  it("leaves unknown questions to the AI step", () => {
    expect(matchProfile("Why do you want to work here?", profile)).toBeNull();
  });
});

describe("chooseOption", () => {
  const bands = ["0-1 years", "1-3 years", "3+ years"];
  it("maps a number onto a single matching band", () => {
    expect(chooseOption("2", bands)).toBe("1-3 years");
    expect(chooseOption("5", bands)).toBe("3+ years");
  });
  it("refuses when the number fits two bands", () => {
    expect(chooseOption("1", bands)).toBeNull();
  });
  it("maps yes/no and rejects anything not in the list", () => {
    expect(chooseOption("Yes", ["Yes, willing", "No"])).toBe("Yes, willing");
    expect(chooseOption("Maybe", ["Yes", "No"])).toBeNull();
  });
});

describe("PROTECTED", () => {
  it.each([
    "Gender", "I agree to the terms and conditions", "Are you a person with a disability?",
    "Veteran status", "Date of birth", "Aadhaar number", "I certify the above is true",
  ])("blocks %s", (label) => expect(PROTECTED.test(norm(label))).toBe(true));

  it.each(["Why this role?", "Current city", "LinkedIn URL"])("allows %s", (label) =>
    expect(PROTECTED.test(norm(label))).toBe(false));
});
