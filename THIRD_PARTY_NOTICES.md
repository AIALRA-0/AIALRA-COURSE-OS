# Third-party notices

## OpenMAIC teaching context and narration

Portions of `apps/api/src/upstream/openmaic-course-context.ts` and
`config/generation-harness/planned-writing-prompt.md` are adapted from
THU-MAIC/OpenMAIC commit `1c70e86a13b07ea1ed6a6b160582e2e05aecdb3c`.
Copyright (c) 2026 THU-MAIC, licensed under the MIT License.
The complete license is retained in `apps/api/src/upstream/OPENMAIC-LICENSE.txt`.
Adaptation scope and differences are documented in
`docs/teaching-upstream-adaptation.md`.

## pypdfium2 and bundled PDFium

The converter image pins pypdfium2==4.30.0 for PDF inspection and rasterization.
The pypdfium2 project is available under either the Apache-2.0 or BSD-3-Clause
license. Its wheel bundles PDFium and ships the applicable PDFium and bundled
third-party license texts as
pypdfium2-4.30.0.dist-info/LicenseRef-PdfiumThirdParty.txt; the converter
image retains that installed virtual environment.

Sources: [pypdfium2 project](https://github.com/pypdfium2-team/pypdfium2),
[pypdfium2 4.30.0 release](https://pypi.org/project/pypdfium2/4.30.0/).

## agent-human-readable-technical-writing

Course OS includes exact policy snapshots from
[`AIALRA-0/agent-human-readable-technical-writing`](https://github.com/AIALRA-0/agent-human-readable-technical-writing)
at commit `d4d4b11d6122c0f538186b2f5553f7cce7eb2480`

Included files:

- `config/generation-harness/policy-skill.md`
- `config/generation-harness/policy-format-rules.md`
- `config/generation-harness/policy-explanation-framework.md`
- `config/generation-harness/policy-formula-explanation.md`

MIT License

Copyright (c) 2026 AIALRA-0

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
