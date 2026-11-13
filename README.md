# ApplySense

Chrome MV3 extension that fills in job application forms, can move through the pages, and **never submits the application**. It works fully offline with no API key.

## What it does

- **Fill this page** answers every question on the current page.
- **Fill and continue** does that, clicks Next, and repeats on the following page. It stops whenever something needs you.
- **Stop** (appears while it is running) cancels immediately, even in the middle of a dropdown. Fields already filled stay filled.

| Colour | Meaning |
|---|---|
| Green | Filled from your saved details, or copied from your resume |
| Blue | Drafted by Gemini (only if you added a key). Always review these |
| Orange | Left for you: files, checkboxes, dates, gender/disability/consent/legal questions, anything your details or resume do not cover |

The popup shows one small square per form field in the same colours, and the same colours outline the fields on the page.

## Where answers come from (no AI required)

1. **Your own answers** (Options, `question phrase => answer`). They override everything.
2. **Your details**: name, address, phone and phone code, country, notice period, salary expectation, eligibility, relocation, minimum age, previous employment, how you heard about the company, and so on.
3. **Your resume, read with plain rules**: Work Experience and Education are copied word for word (titles, companies, dates, bullets, degree, field, GPA). Blank "College", "Degree", "CGPA", "Graduation year", "Current company" answers are filled from it too. Questions about 10th/12th marks are never answered with your college details.
4. **Gemini, optional**: only for open-ended questions ("Why do you want this role?"). Without a key those fields are left orange.

Options shows, under each resume, how many jobs and education entries were read from it, so you can check the parser before relying on it.

## Supported forms

- **Standard HTML forms**, including iframes: text, selects, radio buttons, textareas.
- **Custom dropdowns** (button + list, search-as-you-type, Workday-style): it opens the list and picks the closest option, exact match first, or leaves the field orange.
- **Workday-style sections**: clicks the section's own **Add** button once per entry and fills each block.
- **Google Forms**: question titles, short answer, paragraph, multiple choice, dropdown. Required questions are detected.
- **Microsoft Forms**: question titles, text, multiple choice.
- The "Other:" text box beside a multiple-choice question is never treated as a separate question.

## What it will and will not click

It clicks only: radio options, dropdown triggers and options, an "I currently work here" checkbox, a section's **Add** button, and **Next / Continue / Save and Continue**. It never clicks anything labelled Submit, Apply, Finish, Send, Confirm, Complete or Done, or any button whose Microsoft Forms id says submit. If only one of those is left it stops and tells you to submit it yourself.

"Fill and continue" also stops when a required field is still empty, when there are blue drafts to review, when Next does not move the page on, or after 8 pages.

One caveat: a site that labels its final submit button "Next" or "Continue" cannot be told apart. Use **Fill this page** (which clicks no buttons) if you are unsure.

## Setup

```bash
git clone https://github.com/aditya91203/ApplySense.git
cd ApplySense
npm install
npm run build
npm test
```

Chrome: `chrome://extensions` -> Developer mode -> Load unpacked -> select `dist/`.

In **Options**: paste up to 3 resumes as plain text (or load a .txt), type your details (or import a JSON file with the same field names), and Save. A Gemini key is optional.

## Limits

- Everything is tested against mock pages that follow these sites' structures, with decoy Submit buttons, and against your two resumes. **Not yet tested on a live Workday, Naukri, LinkedIn, Google Forms or Microsoft Forms page.** Microsoft Forms markup was checked against a published example; Google Forms markup is from memory. If a field is missed, tell me the page and I will tune the scanner.
- Google Forms dropdowns and radios are clicked with synthetic mouse events. If Google ignores them on a real form, that field is left orange and listed in the popup.
- File uploads, date pickers and checkbox questions are left to you.
- The resume parser expects `Title | dates` then `Company | location`, and `School` then `Degree; GPA | dates`. Other layouts may be read partly or not at all (Options shows what was found).

## Privacy

Settings and resumes stay in `chrome.storage.local`. With no key, nothing is sent anywhere. With a key, when you fill, your resume text, the form questions, the visible page text and some saved details (never email, phone, address, postal code or salary) go to the Gemini API. On the free tier Google may use that to improve its products.

## Layout

```
src/fill/inject.ts       scanPage, fillPage, prepareSection, advancePage, setCancelFlag (run inside the page)
src/fill/parseResume.ts  rule-based resume reader
src/fill/plan.ts         your details vs AI vs left-for-you
src/fill/entries.ts      maps resume entries onto Work Experience / Education fields
src/fill/draftAnswers.ts optional Gemini drafting
src/background/index.ts  the fill / continue / stop loop
src/popup, src/options   UI
tests/                   82 tests (fixtures use placeholder details): matching, parser, forms, dropdowns, sections, Stop, full runs with no key
```

## Licence

MIT
=======
# ApplySense
