# Shoebox — AI 영수증 분석·지출 관리

Google AI Studio에서 시작한 React + TypeScript + Gemini 앱입니다. 기본 언어는 한국어이며 상단에서 English로 전환할 수 있습니다. 언어 선택은 이 브라우저에 저장됩니다.

- 소스: https://github.com/djai32521/Expense_Receipts_Analytics
- Pages 배포 주소: https://djai32521.github.io/Expense_Receipts_Analytics/
- AI Studio 원본: https://ai.studio/apps/bundled/shoebox-receipts
- 티스토리 원고: [docs/tistory-ai-receipts.md](docs/tistory-ai-receipts.md)

## 기능

영수증 사진/PDF에서 상호, 날짜, 금액, 통화, 세금 정보 등을 추출하고 코드로 합계를 검산합니다. 중복 후보를 표시하며 사용자가 확인 후 합계에서 제외할 수 있습니다. 상호·분류·비용센터별 보기, 원본 대조와 수정, CSV 내보내기를 지원합니다. 외화는 환율과 기준일을 지정하기 전까지 별도로 유지합니다.

## GitHub Pages와 실제 AI 분석

Pages는 정적 프런트엔드입니다. **샘플 영수증 체험**은 API 키 없이 동작하며, 가상 영수증 5개로 중복 표시·지출 보기·수정·CSV 내보내기를 체험할 수 있습니다. 샘플은 실제 분석 결과가 아닙니다.

실제 업로드 파일 분석은 Express API 서버가 필요합니다. 로컬에서는 `npm run dev`로 함께 실행됩니다. Pages에서는 별도로 호스팅한 HTTPS 서버 주소를 **서버 연결 설정**에 입력하세요. 영수증은 해당 서버로 전송됩니다. 서버는 같은 저장소의 `/api/read-receipts`, `/api/check-duplicates`, `/api/workspace-config`를 제공해야 합니다.

## 로컬 실행

Node.js 24 환경을 사용합니다.

```powershell
npm ci
Copy-Item .env.example .env.local
# .env.local에 자신의 GEMINI_API_KEY를 입력하세요.
npm run dev
```

http://localhost:3000 에 접속하세요. `.env.local`은 `.env`보다 우선하며 이미 설정된 환경변수가 최우선입니다. 계정에서 사용 가능한 모델을 쓰려면 `GEMINI_MODEL`을 지정하세요. 원본 모델 ID의 사용 가능 여부는 계정에서 확인해야 합니다.

Windows에서 경로에 `&`가 있어도 실행할 수 있도록 `dev`는 `node --import tsx server.ts`로 구성했습니다. Vite 8과 충돌하던 esbuild는 `^0.28.0`으로 맞췄습니다. npm을 기준으로 `package-lock.json`을 사용하며, 기존 `bun.lock`은 과거 내보내기 파일입니다.

## 검증과 프로덕션 실행

```powershell
npm run lint
npm test
npm run build
$env:NODE_ENV = 'production'
npm start
```

별도 서버에는 `GEMINI_API_KEY`, 선택적으로 `GEMINI_MODEL`, `PORT`, `ALLOWED_ORIGINS`를 설정하세요. Pages의 기본 허용 Origin은 `https://djai32521.github.io`입니다. `ALLOWED_ORIGINS`는 쉼표로 구분합니다. Node.js 서버 호스팅 비용과 Gemini 사용 요금은 각 서비스 정책에 따릅니다.

## GitHub Pages 자동 배포

저장소의 **Settings → Pages → Build and deployment → Source → GitHub Actions**를 선택하세요. `main`에 커밋하면 `.github/workflows/pages.yml`이 `npm ci`, 타입 검사, 계산 테스트, Vite 빌드를 수행하고 `dist`를 배포합니다. 상대 asset 경로(`base: './'`)로 프로젝트 하위 URL을 지원합니다. 저장소 업로드만으로 Pages 활성화가 완료되는 것은 아니며 Actions 성공과 공개 URL을 확인해야 합니다.

## Workspace 연결

Google Drive/Gmail 연동은 Google OAuth/Firebase 설정이 필요합니다. 자신의 프로젝트에서 필요한 API와 OAuth 동의 화면, 허용 도메인·Origin을 설정하세요. 데모 데이터 체험에는 Google 로그인이 필요 없습니다. 연결·스캔·가져오기는 사용자가 해당 UI를 실행할 때 수행됩니다.

## 키와 데이터

실제 API 키는 `.env.local` 또는 서버 비밀 환경변수에만 저장하세요. `VITE_` 변수는 프런트엔드 번들에 포함될 수 있으므로 비밀 키를 넣지 마세요. `.env.local`, `.env`, `.dev.env.json`, `.runtime`, `node_modules`, `dist`는 Git에서 제외합니다. 저장소와 블로그에는 가상 데이터와 플레이스홀더만 사용합니다.

## English

Shoebox extracts receipt fields with Gemini and verifies spend totals in code. Korean is the default; choose **English** in the toolbar. The GitHub Pages site offers fictional sample receipts without an API key. Real uploads require the local Express server or a separately hosted HTTPS backend configured through **Connection settings**. Gemini keys stay on the backend. Duplicate candidates require review and explicit exclusion; foreign currencies stay separate until a conversion is supplied.

Use Node.js 24, run `npm ci`, copy `.env.example` to `.env.local`, configure your key/model, and run `npm run dev`. Select GitHub Actions as the Pages deployment source, then push to `main`. The workflow validates types, tests the calculation engine, builds the frontend, and deploys `dist`.
