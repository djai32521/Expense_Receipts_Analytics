<!--
티스토리 게시용 Markdown 원고. 본문은 첫 H1부터 사용하세요.
권장 제목: Google AI Studio로 AI 영수증 분석 앱 만들기: Gemini·React·GitHub Pages 배포까지
검색 설명: Google AI Studio와 Gemini로 영수증 분석 앱을 만드는 방법. 한국어·영어 전환, 중복 확인, 지출 검산, CSV 내보내기, npm 오류 해결과 GitHub Pages 배포 구조를 코드로 설명합니다.
권장 태그: GoogleAIStudio, Gemini, 영수증분석, 영수증OCR, 지출관리, React, TypeScript, GitHubPages, 바이브코딩, AEO, SEO, GEO
작성 기준일: 2026-10-19
주의: 아래 앱 URL은 배포 대상 주소입니다. 게시 전 Actions 성공과 실제 접속을 확인하세요.
-->

# Google AI Studio로 AI 영수증 분석 앱 만들기: Gemini·React·GitHub Pages 배포까지

**Google AI Studio로 만든 영수증 분석 앱은 영수증을 읽는 AI와 금액을 검산하는 코드를 나누어 설계하면 관리하기 쉽습니다.** 이 글의 Shoebox는 Gemini로 영수증 정보를 추출하고, TypeScript로 합계·통화·중복 후보를 확인한 뒤 결과를 시각화하는 웹 앱입니다. 한국어를 기본으로 제공하고 영어 전환, 원본 대조, 수동 수정, CSV 내보내기를 지원합니다.

이 글에서는 AI Studio에서 시작한 소스를 로컬 프로젝트로 다듬고 GitHub에 공개하는 과정을 설명합니다. 실제로 발생한 `npm install`의 ERESOLVE 오류와 Windows 경로의 `&` 문제도 함께 다룹니다. 마지막에는 GitHub Pages의 정적 호스팅 제약을 해결하는 구조와 티스토리 글에 적용할 SEO·AEO·GEO 작성 방법을 정리합니다.

> **먼저 알아둘 점:** GitHub Pages는 화면과 JavaScript를 배포하는 정적 호스팅입니다. Express 서버를 실행하지 않습니다. 따라서 Pages에서는 가상 영수증 샘플을 체험하고, 실제 영수증 분석에는 별도의 API 서버를 연결하는 구조를 사용합니다.

- 소스 저장소: [Expense_Receipts_Analytics](https://github.com/djai32521/Expense_Receipts_Analytics)
- 앱 배포 대상: [Shoebox 영수증 분석 앱](https://djai32521.github.io/Expense_Receipts_Analytics/)
- AI Studio 출발점: [Shoebox Receipts 앱](https://ai.studio/apps/bundled/shoebox-receipts)

## AI 영수증 분석 앱이란 무엇인가요?

AI 영수증 분석 앱은 사진이나 PDF에 담긴 거래 정보를 구조화하고, 사람이 확인하기 쉬운 지출장부로 바꾸는 도구입니다. 일반적인 OCR이 글자를 추출하는 데 초점을 맞춘다면, 이 프로젝트는 추출 이후의 검토 흐름까지 포함합니다.

예를 들어 카페 영수증에서 상호, 거래일, 합계, 통화를 읽은 뒤 다음 질문을 확인합니다. 금액을 합쳤을 때 장부와 일치하는가? 같은 영수증을 두 번 올린 것은 아닌가? 손글씨 팁이 최종 합계에 반영됐는가? 원화와 달러를 무심코 합산하지 않았는가? 사람이 수정해야 할 항목이 어디에 있는가?

이런 흐름은 개인의 출장비 정리나 프로젝트 비용 검토를 시작하는 데 도움이 됩니다. 다만 AI가 읽은 결과와 자동 분류는 확인 대상입니다. 앱의 출력만으로 세무 증빙의 적법성이나 공제 가능성을 확정할 수는 없습니다.

### 이 프로젝트가 제공하는 기능

| 기능 | 실제 동작 | 확인할 점 |
|---|---|---|
| 영수증 업로드 | 지원 이미지 및 PDF를 받습니다 | HEIC 등은 브라우저 처리 가능 여부를 확인해야 합니다 |
| Gemini 정보 추출 | 상호·날짜·금액·통화·세금 정보를 읽습니다 | 실제 분석에는 서버와 API 키가 필요합니다 |
| 코드 기반 검산 | 추출된 숫자로 합계를 다시 계산합니다 | 원본 숫자를 잘못 읽었다면 사람이 수정해야 합니다 |
| 중복 후보 표시 | 금액·통화·날짜·상호 등을 비교합니다 | 사용자가 확인하고 제외 여부를 결정합니다 |
| 원본 대조 | 영수증 이미지와 추출값을 함께 봅니다 | 흐릿한 이미지의 오류를 확인하는 과정입니다 |
| 지출 시각화 | 상호·분류·비용센터별로 확인합니다 | 분류는 제안값이며 편집 가능합니다 |
| CSV 내보내기 | 검토한 장부를 파일로 저장합니다 | 다음 업무 도구로 옮길 때 활용합니다 |
| 한국어·영어 | 상단에서 UI 언어를 전환합니다 | 첫 실행 기본값은 한국어입니다 |
| Pages 샘플 체험 | 가상 영수증 5개를 불러옵니다 | 실제 AI 인식 성능을 측정한 결과가 아닙니다 |

## Google AI Studio를 출발점으로 선택한 이유

Google AI Studio의 Build 모드는 자연어로 앱의 목적과 동작을 설명하고 코드를 생성·수정하는 개발 흐름을 제공합니다. 화면을 먼저 만들어 본 다음 코드 구조를 확인하고, 로컬 환경이나 GitHub와 연결해 다듬는 방식으로 활용할 수 있습니다. 공식 문서는 서버 측 비밀 키 관리와 외부 배포 환경의 환경변수 설정도 설명합니다. [Google AI Studio Build 공식 문서](https://ai.google.dev/gemini-api/docs/aistudio-build-mode)

여기서 얻는 실용적인 장점은 초기 아이디어를 화면으로 옮기는 속도입니다. 반면 생성된 소스를 다운로드했다고 해서 패키지 호환성, Windows 실행 경로, 비밀 키 관리, 호스팅 환경의 차이까지 자동으로 해결되는 것은 아닙니다. 이 글에서 다루는 작업도 그 간격을 메우는 과정입니다.

### AI Studio에 어떤 프롬프트를 입력하면 좋을까요?

다음은 같은 방향의 앱을 요청할 때 사용할 수 있는 프롬프트 예시입니다. 아래 문장은 재현을 위한 제안이며 원본 앱 제작 시 입력했던 프롬프트 기록은 아닙니다.

```text
영수증 사진과 PDF를 분석하는 지출 관리 웹 앱을 만들어 주세요.

기술: React, TypeScript, Gemini API, Node.js 서버
언어: 한국어 기본, 영어 전환 버튼 제공

처리 흐름:
1. 여러 영수증 파일을 업로드합니다.
2. Gemini가 상호, 날짜, 금액, 통화, 세금, 손글씨 팁을 JSON으로 추출합니다.
3. 합계 계산과 중복 후보 검증은 TypeScript 코드가 담당합니다.
4. 원화와 외화를 환율 입력 없이 합산하지 않습니다.
5. 원본과 결과를 나란히 보여 주고 사람이 수정할 수 있게 합니다.
6. CSV로 내보낼 수 있게 합니다.

배포:
GitHub Pages는 샘플 체험이 가능한 정적 화면으로 구성합니다.
실제 AI 분석 API는 별도 서버에서 실행합니다.
Gemini API 키는 서버 환경변수에만 저장합니다.
```

프롬프트에서 출력 화면뿐 아니라 검증 책임과 배포 조건까지 지정하는 것이 좋습니다. 특히 “AI가 모든 계산을 처리해 주세요”보다 “AI가 읽은 숫자를 코드가 다시 계산하게 해 주세요”라고 요구하면 결과를 검토할 지점이 분명해집니다.

## 전체 구조: AI 추출과 코드 계산을 나누기

이 앱의 실제 영수증 분석 흐름은 다음과 같습니다.

```text
사용자의 영수증 파일
    ↓
React: 파일 확인·브라우저 전처리·배치 구성
    ↓
Express API: /api/read-receipts
    ↓
Gemini: 이미지에서 거래 필드 추출
    ↓
React/TypeScript: 필드 정리·중복 후보 검증·합계 계산
    ↓
결과 화면: 상호별 지출·원본 대조·수정
    ↓
CSV 내보내기
```

AI와 코드가 잘하는 일을 분리하는 설계입니다. 이미지에서 흐릿한 상호나 복잡한 레이아웃의 정보를 읽는 일은 모델에 맡기고, 이미 숫자로 받은 값을 합산하거나 통화별로 묶는 일은 코드에 맡깁니다.

### JSON 형태를 먼저 정하는 이유

AI 응답을 그대로 화면에 출력하면 값이 빠지거나 형식이 바뀔 때 처리가 어려워집니다. 날짜, 통화, 금액, 신뢰도 같은 필드를 미리 정의하면 후속 계산에서 필요한 조건을 확인할 수 있습니다.

아래는 저장소 타입을 이해하기 쉽게 줄인 예시입니다.

```ts
interface ReceiptExtract {
  merchant: string | null;
  date: string | null;
  printed_total: number | null;
  handwritten_tip: number | null;
  final_total: number | null;
  currency: string | null;
  category: string;
}
```

모르는 값을 0으로 채우지 않고 `null`로 구분하는 것도 중요합니다. 금액을 읽지 못한 경우와 실제 금액이 0인 경우는 서로 다른 상황입니다. 이 구분은 검토 대상으로 표시하거나 사람이 값을 입력하는 데 필요합니다.

### AI 출력의 형식을 신뢰하지 않는 입력 정리

실제 `App.tsx`에는 모델 응답을 `ReceiptRow` 형태로 정리하는 `sanitizeRawReceipt` 함수가 있습니다. 분류가 허용된 값인지 확인하고, 이미지 영역 좌표가 숫자인지 확인하며, 누락 필드와 플래그를 정리합니다.

다음은 해당 처리 원리를 단순화한 예시입니다.

```ts
const categories = ["Meals", "Travel", "Lodging", "Office", "Other"];

const category = categories.includes(raw.category)
  ? raw.category
  : "Other";

const printedTotal =
  typeof raw.printed_total === "number" && Number.isFinite(raw.printed_total)
    ? raw.printed_total
    : null;

const currency = raw.currency?.toUpperCase().trim() || null;
```

여기서 타입 선언과 런타임 검증은 역할이 다릅니다. TypeScript 타입은 개발 중 실수를 줄이는 데 도움이 되지만, 네트워크를 통해 받은 JSON이 타입대로 왔다는 사실까지 보장하지는 않습니다. API 경계에서는 실제 값도 확인해야 합니다.

## 금액 검산: 영수증을 읽는 것과 합계를 확인하는 것은 다릅니다

예를 들어 인쇄된 금액이 24달러이고 손글씨 팁이 4달러라면 계산상 합계는 28달러입니다. 모델이 읽은 최종 금액과 코드로 계산한 금액이 다르면 검토 대상으로 볼 수 있습니다.

```ts
// 설명을 위한 축약 예시입니다.
function calculateTotal(printed: number, tip: number | null) {
  return Number((printed + (tip ?? 0)).toFixed(2));
}

const expected = calculateTotal(24, 4); // 28
const mismatch = Math.abs(expected - extractedFinalTotal) > 0.01;
```

저장소의 계산 엔진은 통화의 소수 자릿수를 고려한 보조 단위 계산도 포함합니다. 원화처럼 소수점 이하를 사용하지 않는 통화와 달러처럼 센트 단위가 있는 통화를 같은 방식으로 표시하면 혼란이 생기기 때문입니다.

다만 코드 검산은 추출된 숫자의 내부 일관성을 확인하는 작업입니다. 원본의 12,500원을 AI가 12,800원으로 잘못 읽었는데 관련 필드도 같은 값으로 읽었다면 합계가 일치할 수 있습니다. 원본 대조 화면이 필요한 이유입니다.

### 외화는 왜 따로 보관하나요?

12,500원과 28달러를 숫자만 더해 12,528이라고 표현하면 의미가 없습니다. 이 앱은 주 통화의 합계와 외화 합계를 구분하며, 환율과 기준일을 입력하기 전까지 외화를 별도로 유지합니다.

환산 기능을 추가하거나 사용할 때에는 어떤 날짜의 환율인지, 사용자가 직접 입력했는지, 반올림을 언제 하는지를 기록하는 편이 좋습니다. 이 프로젝트는 자동으로 최신 환율을 가져오는 서비스라고 소개하지 않습니다.

## 중복 영수증은 어떻게 찾나요?

이 프로젝트는 모델이 제안한 중복 후보를 코드로 다시 확인하고, 모델이 놓친 후보를 비교하는 처리도 포함합니다. 주요 비교 항목은 금액, 통화, 가까운 날짜, 비슷한 상호입니다. 추가로 시간과 카드 끝자리의 충돌 여부를 살펴봅니다.

```ts
// 실제 구현의 판단 요소를 줄인 개념 예시입니다.
const candidate =
  sameAmount &&
  sameCurrency &&
  closeDate &&
  similarMerchant &&
  !conflictingTime &&
  !conflictingCard;
```

여기서 **중복 후보 표시와 합계 제외는 별도의 단계**입니다. 같은 카페에서 같은 금액을 두 번 결제할 수도 있습니다. 앱이 후보를 표시하면 사용자가 원본을 비교하고 실제 중복인지 판단한 뒤 제외할 수 있습니다. 자동 감지가 항상 정답이라는 가정으로 데이터를 지우지 않는 것이 중요합니다.

### 가상 샘플로 확인할 수 있는 예

Pages 체험용 샘플은 실제 사용자의 영수증 대신 코드에서 만든 가상 데이터입니다.

| 샘플 | 금액 | 시나리오 |
|---|---:|---|
| Demo Cafe | 12,500 KRW | 일반 식비 |
| Demo Stationery | 34,000 KRW | 사무용품 |
| Demo Taxi | 18,500 KRW | 교통비 |
| Demo Cafe 사본 | 12,500 KRW | 첫 번째 카페 영수증의 중복 후보 |
| Demo Diner | 24 USD + 팁 4 USD | 외화와 손글씨 팁 |

원화 샘플을 모두 포함하면 77,500원입니다. 카페 사본을 검토한 뒤 제외하면 65,000원이 됩니다. 달러 샘플은 28달러로 별도 표시됩니다. 이 숫자는 가상 데이터의 산술 예시이며 실제 OCR 정확도나 업무 효율을 측정한 수치가 아닙니다.

## 한국어 기본·영어 전환은 어떻게 구현했나요?

이번 버전에서는 처음 사용하는 사람에게 한국어를 보여 주고, 상단의 English 버튼으로 UI를 전환하도록 구성했습니다. 브라우저에 저장된 언어가 영어라면 다음 방문에서도 영어를 사용합니다.

기본 처리 원리는 다음과 같습니다. 아래 예시는 저장소의 로직을 줄인 것입니다.

```ts
type Language = "ko" | "en";

let language: Language = "ko";
try {
  language = localStorage.getItem("shoebox-language") === "en"
    ? "en"
    : "ko";
} catch {
  // 저장소 사용이 제한된 환경에서도 한국어로 동작합니다.
}
```

번역은 표시 계층에 적용합니다. 예를 들어 데이터의 분류값 `Meals`는 그대로 유지하고 사용자에게 보여 줄 때만 `식비`로 바꿉니다.

```tsx
<option value="Meals">{t("Meals")}</option>
```

`value`까지 한국어로 바꾸면 기존 계산 엔진의 비교 조건이나 CSV를 읽는 코드와 맞지 않을 수 있습니다. 화면에 표시하는 언어와 내부 데이터 계약을 구분하면 나중에 언어를 더 추가하기도 편합니다.

문서의 `lang` 속성도 선택한 언어에 맞게 변경합니다. 이는 화면 읽기 도구가 문서를 해석하는 데 도움이 됩니다. 이 앱의 언어 전환은 같은 URL 안에서 동작하므로 언어별 별도 페이지와 `hreflang`을 갖춘 대규모 다국어 사이트와는 구조가 다릅니다.

## 로컬 실행 방법: 설치부터 개발 서버까지

이 프로젝트는 Node.js 24 환경을 기준으로 구성했습니다. 먼저 저장소를 내려받고 패키지를 설치합니다.

```powershell
git clone https://github.com/djai32521/Expense_Receipts_Analytics.git
cd Expense_Receipts_Analytics
npm ci
Copy-Item .env.example .env.local
```

`.env.local`에 자신의 API 키를 입력합니다. 아래 값은 예시용 자리 표시자입니다.

```dotenv
GEMINI_API_KEY="YOUR_OWN_GEMINI_API_KEY"
# 계정에서 사용 가능한 모델을 선택할 때만 지정합니다.
# GEMINI_MODEL="your-supported-model-id"
```

```powershell
npm run dev
```

기본 접속 주소는 `http://localhost:3000`입니다. API 키는 Gemini의 실제 요청이 처리되는 서버에서 사용합니다. 계정에 허용된 모델과 사용량 한도는 별도로 확인해야 합니다. 원본 코드에 들어 있던 모델 ID가 모든 계정에서 동작한다고 보장할 수는 없습니다.

### 왜 `.env.local`을 GitHub에 올리면 안 되나요?

브라우저에 배포되는 JavaScript나 공개 저장소에 비밀 키가 들어가면 다른 사람이 사용할 수 있습니다. `.gitignore`에서 환경변수 파일을 제외하고 실제 키는 서버 환경변수에만 저장합니다. 프런트엔드 번들에 노출될 수 있는 `VITE_` 변수에는 서버의 공개 URL 같은 값만 둡니다.

```gitignore
node_modules/
dist/
.env*
!.env.example
.dev.env.json
.runtime/
```

`.gitignore`는 이미 커밋한 비밀 값을 지워 주는 기능이 아닙니다. 키가 공개된 경우에는 해당 서비스에서 키를 폐기하고 새 키로 교체하는 조치가 필요합니다. 블로그 코드 예시에도 실제 키나 GitHub 토큰을 넣지 않습니다.

## 실제 오류 해결 1: npm ERESOLVE와 esbuild 충돌

처음 `npm install`을 실행했을 때 이 프로젝트에서는 다음 종류의 오류가 발생했습니다.

```text
ERESOLVE could not resolve
While resolving: vite@8.3.4
Found: esbuild@0.25.12
peerOptional esbuild@"^0.27.0 || ^0.28.0" from vite@8.3.4
```

원인은 루트 프로젝트가 `esbuild: ^0.25.0`을 요청하는데 설치되는 Vite가 더 높은 호환 범위를 요구한 것입니다. 오류 로그에 나온 범위에 맞춰 직접 의존성을 변경했습니다.

```json
{
  "devDependencies": {
    "esbuild": "^0.28.0"
  }
}
```

이 사례에서는 의존성의 호환 범위를 맞추는 것이 해결 방향입니다. `--force`나 `--legacy-peer-deps`로 충돌 검사를 건너뛰는 방법은 사용하지 않았습니다. 다른 프로젝트에서는 실제 로그의 요구 버전을 확인해야 하며 이 버전 숫자를 무조건 복사하는 방식은 적절하지 않습니다.

패키지 버전을 바꾼 뒤에는 `npm install`로 lockfile을 갱신하고, 배포 서버에서는 커밋된 `package-lock.json`을 기준으로 `npm ci`를 실행합니다. 설치 결과를 팀과 CI가 함께 재현하도록 만드는 과정입니다.

## 실제 오류 해결 2: Windows 폴더명의 `&`와 tsx 실행 경로

다음 오류는 패키지 설치 이후 `npm run dev`를 실행할 때 발생했습니다.

```text
'-receipts-analytics\node_modules\.bin\'은(는)
내부 또는 외부 명령이 아닙니다.

Cannot find module '...\Downloads\tsx\dist\cli.mjs'
```

프로젝트 폴더 이름에는 `expense-&-receipts-analytics`처럼 `&`가 들어 있었습니다. Windows의 명령 처리 과정에서 배치 실행 경로가 나뉘며 `tsx`의 실제 위치와 다른 경로를 찾는 상황이었습니다.

수정 전에는 npm script가 실행 파일 이름만 호출했습니다.

```json
{
  "scripts": {
    "dev": "tsx server.ts"
  }
}
```

수정 후에는 Node.js의 import hook으로 TypeScript 실행 환경을 불러오게 했습니다.

```json
{
  "scripts": {
    "dev": "node --import tsx server.ts",
    "build": "node ./node_modules/vite/bin/vite.js build",
    "preview": "node ./node_modules/vite/bin/vite.js preview",
    "lint": "node ./node_modules/typescript/bin/tsc --noEmit"
  }
}
```

이 변경은 해당 프로젝트의 명령 실행에서 `.bin` 배치 파일을 거치는 경로를 줄입니다. 설치가 정상적으로 끝난 상태라면 이 스크립트 수정 때문에 패키지를 다시 설치할 필요는 없습니다. 새 작업 폴더 이름을 정할 수 있다면 특수문자를 줄이는 것도 운영상 편리합니다.

## GitHub Pages에 배포할 때 생기는 구조적 차이

GitHub Pages는 저장소의 HTML, CSS, JavaScript 같은 정적 파일을 제공하는 서비스입니다. 서버 측의 Node.js/Express 프로세스를 지속적으로 실행하는 호스팅은 아닙니다. [GitHub Pages 소개](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

따라서 로컬에서 `/api/read-receipts`가 잘 동작했다고 해도, 프런트엔드 빌드 파일만 Pages에 올리면 같은 API가 자동으로 생기지는 않습니다. 특히 `fetch("/api/read-receipts")`는 Pages의 루트에서 존재하지 않는 경로를 요청하게 됩니다.

이 프로젝트에서는 목적에 따라 두 가지 흐름을 제공합니다.

| 실행 방식 | 필요한 것 | 가능한 작업 |
|---|---|---|
| GitHub Pages 샘플 | 브라우저 | 가상 데이터의 결과 보기·수정·중복 검토·CSV |
| 로컬 통합 실행 | Node.js, Gemini 키 | 자신의 파일을 실제 AI로 분석 |
| Pages + 외부 API | 정적 화면, 별도 HTTPS 서버, 서버 키 | 배포 화면에서 실제 파일 분석 |

샘플 기능은 서버가 없는 상황에서도 UI와 계산 흐름을 확인하는 방법입니다. 실제 사진을 올렸는데 샘플 결과로 대신 보여 주는 방식은 사용하지 않습니다. 서버 연결이 없는 Pages에서 실제 분석을 시도하면 연결 설정이 필요하다는 안내를 제공합니다.

### 서버 주소를 한곳에서 관리하기

프런트엔드의 API 요청은 `src/utils/api.ts`의 헬퍼를 사용합니다. 서버 주소가 있으면 그 주소 앞에 API 경로를 붙이고, 로컬에서는 같은 Origin의 API를 호출합니다.

```ts
// 구조를 보여 주는 축약 예시입니다.
function apiFetch(path: string, init?: RequestInit) {
  const base = getApiBase();
  return fetch(`${base}${path}`, init);
}

await apiFetch("/api/read-receipts", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
```

실제 구현은 HTTPS 주소를 검증하고, Pages에 서버 주소가 설정되지 않았다면 명시적으로 오류를 반환합니다. 연결 설정에는 API 키를 입력하지 않습니다. 입력하는 값은 업로드를 처리할 서버의 공개 주소입니다.

### API 서버의 CORS 설정

Pages 화면과 별도 서버는 Origin이 다릅니다. 서버가 브라우저의 교차 출처 요청을 허용하도록 설정해야 합니다. 이 저장소는 `ALLOWED_ORIGINS` 환경변수로 허용 Origin을 지정합니다.

```dotenv
ALLOWED_ORIGINS="https://djai32521.github.io"
```

Origin에는 저장소 경로가 붙지 않습니다. 예를 들어 Pages 주소가 `https://djai32521.github.io/Expense_Receipts_Analytics/`여도 Origin은 `https://djai32521.github.io`입니다. CORS는 브라우저의 접근 규칙이며 API 인증이나 사용량 제한을 대신하지는 않습니다. 공개 API를 운영할 때는 실제 운영 목적에 맞는 인증·요금 관리를 추가해야 합니다.

## GitHub Actions로 검사와 배포를 자동화하기

저장소의 `main` 브랜치에 변경을 올리면 GitHub Actions가 다음 단계를 수행하도록 구성했습니다.

```text
npm ci
  → npm run lint
  → npm test
  → npm run build
  → dist 업로드
  → GitHub Pages 배포
```

실제 workflow는 `.github/workflows/pages.yml`에 있습니다. 핵심 설정은 다음과 같습니다.

```yaml
permissions:
  contents: read
  pages: write
  id-token: write

steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: '24'
      cache: npm
  - run: npm ci
  - run: npm run lint
  - run: npm test
  - run: npm run build
```

이 코드는 workflow 전체가 아닌 검사 단계의 발췌입니다. 전체 파일에는 Pages artifact 업로드와 배포 job도 포함됩니다. GitHub 문서의 사용자 지정 workflow 설명과 함께 확인할 수 있습니다. [GitHub Pages 사용자 지정 workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

저장소 설정에서 **Settings → Pages → Build and deployment → Source → GitHub Actions**를 선택해야 합니다. 이후 Actions 실행이 성공하고 공개 URL이 실제로 열리는 것까지 확인하면 됩니다. 파일 업로드, 빌드 성공, 공개 사이트 동작은 서로 다른 확인 단계입니다.

### Vite의 base 경로는 왜 중요할까요?

프로젝트 Pages는 `/Expense_Receipts_Analytics/` 하위에서 열립니다. asset 경로가 루트 기준으로 고정되면 JavaScript나 CSS를 찾지 못해 빈 화면이 나올 수 있습니다. 이 프로젝트의 Vite 설정은 상대 경로를 사용합니다.

```ts
export default defineConfig(() => ({
  base: "./",
  plugins: [react(), tailwindcss()],
}));
```

라우팅을 사용하는 다른 앱에서는 새로고침 시의 경로 처리도 확인해야 합니다. 현재 Shoebox는 한 페이지에서 상태를 바꾸는 방식이므로 복잡한 클라이언트 라우트 설정을 전제로 하지 않습니다.

## SEO·AEO·GEO·AI SEO를 이 글에 어떻게 적용했나요?

이 글에서 SEO는 검색엔진이 문서를 이해하고 발견하기 쉽게 만드는 기본 작업을 뜻합니다. AEO는 사용자의 질문에 명확한 답을 제공하는 글 구조로, GEO는 생성형 검색이나 답변 서비스가 문맥과 근거를 파악하기 쉬운 서술 방식으로 사용합니다. AI SEO는 이런 활동을 넓게 부르는 표현입니다. 서비스마다 사용하는 명칭과 구현 방식은 다를 수 있습니다.

이 용어들을 특정 순위 보장 기술로 설명하지는 않습니다. Google은 AI Overviews와 AI Mode에 노출되기 위한 별도의 특별 최적화나 전용 마크업이 필요하지 않으며 기존 SEO 기본 원칙이 계속 중요하다고 설명합니다. 색인이나 노출도 보장되지 않습니다. [Google의 AI 검색 기능 안내](https://developers.google.com/search/docs/appearance/ai-features)

### 1. 제목과 첫 문단에서 질문에 답하기

독자가 “Google AI Studio로 영수증 분석 앱을 만들 수 있나요?”라고 검색했다면 첫 문단에서 가능한 구조를 알아야 합니다. 그래서 도구 이름, 앱의 목적, AI와 코드의 역할을 도입부에 명시했습니다.

제목에는 `Google AI Studio`, `AI 영수증 분석 앱`, `Gemini`, `React`, `GitHub Pages`를 자연스럽게 포함했습니다. 같은 키워드를 모든 문장에 반복하기보다 각 기술이 어떤 문제를 해결하는지 설명했습니다.

### 2. 모호한 홍보 문구 대신 재현 가능한 근거 제공

실제 발생한 오류 메시지, 수정 전후의 npm script, 파일 이름, 샘플 데이터의 계산 예시를 제시했습니다. “정확도가 뛰어나다” 또는 “업무 시간이 크게 줄었다” 같은 측정하지 않은 성과는 쓰지 않았습니다.

샘플 데이터가 실제 AI 분석 결과가 아니라는 점도 반복이 필요한 위치에서 설명합니다. 독자가 앱의 기능과 실험 결과를 혼동하지 않게 하는 것이 문서 신뢰도에 도움이 됩니다.

### 3. 질문형 소제목과 짧은 직접 답변

“GitHub Pages에서 Gemini API를 사용할 수 있나요?”, “API 키를 어디에 저장하나요?” 같은 질문은 FAQ로 정리했습니다. 각 답변은 조건을 먼저 말한 뒤 이유를 덧붙입니다. 문단 하나만 인용되더라도 의미가 뒤집히지 않도록 “샘플”, “실제 분석”, “별도 서버”를 함께 적습니다.

### 4. 공식 문서와 구현 근거 연결

AI Studio의 기능 설명은 Google 공식 문서에, Pages의 실행 제약은 GitHub 공식 문서에 연결했습니다. 구현 세부사항은 공개 저장소에서 확인할 수 있게 했습니다. 내용이 바뀔 수 있는 제품 기능은 게시 시점의 공식 안내를 다시 확인하는 것이 좋습니다.

Google의 사용자 중심 콘텐츠 가이드는 독자가 작업을 완수할 수 있는 실질적인 정보와 신뢰 가능한 설명에 초점을 맞춥니다. 이 원고 역시 키워드 밀도보다 설치·실행·오류 해결·배포 판단에 필요한 정보에 분량을 사용했습니다. [사용자 중심 콘텐츠 안내](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)

### 5. 앱의 메타데이터와 구조화 데이터

앱의 `index.html`에는 한국어 제목, 설명, canonical URL, Open Graph 메타데이터와 소프트웨어 설명용 JSON-LD를 넣었습니다. 화면의 기능과 실제로 일치하는 정보만 포함하고 확인되지 않은 평점이나 이용자 수를 넣지 않았습니다.

```html
<html lang="ko">
<title>Shoebox | AI 영수증 분석·지출 관리</title>
<meta name="description"
      content="영수증 정보 추출, 코드 기반 검산, 중복 확인과 지출 시각화 앱" />
<link rel="canonical"
      href="https://djai32521.github.io/Expense_Receipts_Analytics/" />
```

이 메타데이터는 앱의 HTML에 들어가는 예시입니다. 티스토리 본문에 코드를 붙여 넣는 것만으로 블로그 문서의 head 설정이 바뀌지는 않습니다. 티스토리 글의 제목·설명·공유 미리보기는 사용 중인 편집기와 스킨의 출력 결과를 확인해야 합니다.

또한 저장소 하위에 배포한 `robots.txt`가 도메인 루트의 robots 파일을 대신하지는 않습니다. 프로젝트 사이트에서는 상위 도메인의 크롤링 정책과 실제 검색 수집 상태를 함께 확인해야 합니다. 구조화 데이터나 sitemap을 추가했다고 검색 결과에 즉시 노출되는 것은 아닙니다.

## 자주 묻는 질문

### Google AI Studio만으로 영수증 분석 앱을 만들 수 있나요?

초기 화면과 Gemini 연동 코드를 만드는 출발점으로 활용할 수 있습니다. 배포 전에 패키지 버전, 오류 처리, 비밀 키 보관, 실행 환경을 확인해야 합니다. 이 프로젝트는 AI Studio에서 시작한 소스를 React·TypeScript·Express 구조로 다듬은 사례입니다.

### GitHub Pages에서 실제 영수증을 AI로 분석할 수 있나요?

Pages 화면에서 별도 API 서버를 호출하는 방식으로 가능합니다. Pages 자체는 Express를 실행하지 않습니다. 이 앱은 서버가 없는 상황에서는 가상 샘플을 체험하고, 실제 분석에는 서버 주소를 연결하도록 구성했습니다.

### 데모를 보려면 Gemini API 키가 필요한가요?

샘플 영수증 체험에는 키가 필요 없습니다. 실제 업로드 파일을 Gemini로 읽으려면 서버의 `GEMINI_API_KEY` 설정과 해당 계정에서 사용 가능한 모델이 필요합니다.

### 한국어와 영어는 어떻게 바꾸나요?

상단의 한국어 또는 English 버튼을 누르면 됩니다. 첫 방문은 한국어이며 선택한 언어를 브라우저에 저장합니다. 영수증의 상호나 원본 내용 자체를 번역하는 기능과 UI 언어 전환은 별개입니다.

### 중복 영수증은 자동으로 삭제되나요?

아닙니다. 중복 후보를 표시하고 사람이 검토한 뒤 합계에서 제외할 수 있습니다. 같은 장소에서 같은 금액을 결제한 별개 거래를 잘못 제거하지 않도록 원본을 대조하는 단계가 필요합니다.

### 원화와 달러를 한 번에 합산하나요?

환율과 기준일이 없는 외화는 주 통화와 분리합니다. 환산을 지정한 경우에만 해당 설정에 따라 반영합니다. 앱이 자동으로 최신 시장 환율을 보장하는 구조는 아닙니다.

### CSV를 엑셀이나 다른 도구에서 사용할 수 있나요?

CSV는 표 데이터를 옮기는 일반적인 형식이므로 해당 도구의 가져오기 기능으로 사용할 수 있습니다. 날짜와 금액 형식, 문자 인코딩, 열의 의미를 가져오기 화면에서 확인하세요. 업로드 원본과 검토 결과를 함께 보관하면 추후 대조에도 도움이 됩니다.

### 영수증 분석 결과를 세무 신고에 바로 사용해도 되나요?

앱은 정보 정리와 검토를 돕습니다. 영수증의 증빙 요건이나 비용 처리 가능 여부를 확정하는 기능은 아닙니다. 원본과 추출값을 대조하고 실제 신고 업무의 기준에 따라 검토해야 합니다.

### `npm install`에 실패하면 무조건 `--force`를 쓰면 되나요?

이 사례에서는 Vite와 esbuild가 요구하는 버전 범위를 맞춰 해결했습니다. 먼저 오류 로그의 `Found`, `Could not resolve dependency`, `peer` 부분을 확인하고 충돌하는 패키지를 조정하는 것이 좋습니다.

### SEO·AEO·GEO를 적용하면 AI 답변에 반드시 인용되나요?

보장할 수 없습니다. 읽기 쉬운 구조, 질문에 대한 직접 답변, 검증 가능한 근거, 접근 가능한 페이지가 도움이 되는 기본 조건입니다. 특정 검색엔진이나 생성형 서비스의 선택을 확정하는 방법으로 소개하지 않습니다.

## 게시 전 확인할 내용

글을 공개하기 전에 소스 링크와 앱 링크가 실제로 열리는지 확인합니다. Pages의 샘플 화면과 서버 연결이 필요한 실제 분석을 구분해 설명하고, 코드 예시의 API 키는 모두 자리 표시자인지 확인합니다. 화면을 캡처할 때에는 실제 영수증의 카드번호·상호·거래 내역 대신 가상 샘플을 사용하는 편이 좋습니다.

티스토리에서는 Markdown 모드에서 이 본문을 붙여 넣은 뒤 코드 블록, 표, 링크가 의도대로 표시되는지 미리보기로 확인하세요. 블로그 제목 입력란과 본문의 H1이 중복될 경우 본문 첫 제목을 제거해 문서 구조를 정리할 수 있습니다. 앱 화면 캡처를 추가한다면 `한국어 기본 화면`, `중복 영수증 검토`, `CSV 내보내기`처럼 화면의 실제 내용을 alt 텍스트에 적습니다.

이 프로젝트에서 얻을 수 있는 개발상의 핵심은 명확합니다. AI가 영수증을 읽고, 코드가 계산을 검증하며, 사람이 원본을 확인합니다. 이 세 단계를 화면과 배포 구조에 함께 반영하면 AI Studio에서 만든 초기 앱을 공개 가능한 프로젝트로 다듬는 데 도움이 됩니다.

## 참고 자료

- [소스 코드: Expense_Receipts_Analytics](https://github.com/djai32521/Expense_Receipts_Analytics)
- [Google AI Studio Build 공식 문서](https://ai.google.dev/gemini-api/docs/aistudio-build-mode)
- [GitHub Pages 소개](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub Pages 사용자 지정 workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Google Search: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- [Google Search: 사용자 중심 콘텐츠](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)

**작성 기준:** 2026년 10월 19일. 제품 기능과 패키지 버전은 변경될 수 있으므로 실제 실행 시 저장소의 lockfile과 공식 문서를 함께 확인하세요.
