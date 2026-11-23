# Reference page test plan

The contract ledger for [the reference page](README.md). Every case runs in `bun test` from
`web/test/reference.test.ts`: Chrome through playwright-core, the Vite dev server, and a real School
server over course folders the test writes, one of them with a `.txt` file and a symlink that leaves
the course in its `reference/` folder.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| REF-1 | Every document linked | Every file name in `GET /api/courses/:c`'s `reference`, in order, links to `/courses/:c/reference/<encoded file>`; nothing else (not the `.txt`, not the symlink) is shown | implemented | `a course with reference documents > links every document the API lists, in its order, to the file School serves` |
| REF-2 | A document opens | Clicking opens a new tab (`target=_blank`, `rel` with `noopener`) on the served address, showing the document's text; the app tab stays | implemented | `a course with reference documents > a document opens in a new tab, as School serves it` |
| REF-3 | Keys | `j` and `k` move between documents and `↵` opens the focused one in a new tab | implemented | `a course with reference documents > the documents are reachable with j and k, and Enter opens the focused one` |
| REF-4 | Key hints | `j`, `k` and `↵` shown with Kbd | implemented | `a course with reference documents > shows the keys with Kbd` |
| REF-5 | Breadcrumb | Home / course / Reference; the course crumb opens the course page without a page load | implemented | `a course with reference documents > the breadcrumb leads back to the course, routed on the client` |
| REF-6 | Width | One column at 390 px, four documents side by side at 1920 px | implemented | `a course with reference documents > uses the width: one column on a phone, several on a wide screen` |
| REF-7 | Loading | Skeletons and a Spinner while the request is held, gone once it answers | implemented | `states > while the list loads, it shows Skeletons and a Spinner, then the documents` |
| REF-8 | No references | A course with no reference folder shows "No reference documents" | implemented | `states > a course without reference documents says so` |
| REF-9 | Unreadable lessons | A course whose lessons fail validation answers 200 with `lessons: null`, `lessonsError` and its `reference`; the page links its documents, they open, and no alert is shown (flyingrobots/school#115) | implemented | `states > a course whose lessons cannot be read still lists its reference documents` |
| REF-10 | Unknown course | A 404 shows "There is no course called …" | implemented | `states > a course that does not exist says so` |
| REF-11 | Unreachable server, Try again | A refused connection shows "The reference documents could not be loaded"; Try again then shows the documents | implemented | `states > a server that cannot be reached is reported, and Try again shows the documents once it answers` |
| REF-12 | Wrong shape | A body that fails the Zod schema is reported as not loaded, and nothing is drawn | implemented | `states > an answer of the wrong shape is reported as not loaded, not drawn` |
| REF-13 | Keys during the intro | As soon as the list is shown, while it animates in, every link in the main region (crumbs and documents) takes focus | implemented | `a course with reference documents > every document and crumb can take focus as soon as the list is shown, while it animates in` |
| REF-14 | Browser title | The tab reads `Reference · <course> · School` | implemented | `a course with reference documents > the browser title names the reference and its course` |
