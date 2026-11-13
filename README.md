# DangDang_internet

브라우저에서 대화하고 함께 놀 수 있는 Chrome Manifest V3 반려 AI입니다. 사이드 패널과 플로팅 아바타, 로컬 대화 이력과 기억, 범용 코딩 프로젝트, KIPRIS PLUS 특허 심사품질 진단을 지원합니다.

## 로컬 설치

1. [GitHub Actions](https://github.com/teamprotofelix/DangDang_internet/actions)의 성공한 실행에서 **DangDang_internet_Chrome** 설치용 ZIP을 받습니다.
2. 압축을 풀고 Chrome의 `chrome://extensions`에서 **개발자 모드 → 압축해제된 확장 프로그램을 로드합니다**를 누른 뒤, `manifest.json`이 들어 있는 폴더를 선택합니다. 설치용 ZIP에는 PDF.js, 워커, 글꼴 및 문자 매핑 파일이 들어 있어 Node.js와 npm 없이 사용할 수 있습니다.
3. PDF.js 누락 메시지가 표시되는 기존 사용자는 설치용 ZIP을 기존 설치 폴더에 풀어 덮어쓴 뒤 **새로고침**을 누르세요. 기존 확장을 제거하면 브라우저에 저장한 자료에 접근할 수 없으므로 같은 확장 설치에서 갱신합니다. 저장된 원문은 **텍스트 추출 재시도**로 다시 읽을 수 있습니다.

GitHub의 **Code → Download ZIP**은 개발용 소스입니다. 개발 환경에서는 Node.js 24로 `npm ci`와 `npm run package:extension`을 실행하고 `dist/DangDang_internet`을 로드합니다.

## 대화와 코딩

- 대화창에서 **코드 요청**을 켜고 보냅니다. 언어는 `auto`로 감지하거나 목록에 없는 이름을 직접 입력할 수 있습니다. 이후 메시지도 같은 프로젝트 파일을 참고해 수정합니다. 코드 요청을 끄면 일반 대화로 돌아갑니다.
- 대화의 **코드 요청**을 켜고 목록에서 언어를 선택하거나 직접 입력합니다. 대화 하단 **코드 프로젝트**에서 저장 파일을 열고 파일명을 바꾸거나 ZIP으로 받을 수 있습니다. **새 프로젝트**를 선택하면 다음 요청을 빈 상태에서 시작합니다. 결과 카드의 **다시 생성**은 그때 보낸 요청과 파일을 사용하고, **프로젝트 ZIP**은 해당 응답 시점의 파일을 담습니다.
- 모델이 반환한 소스는 텍스트로 표시합니다. 다운로드한 파일의 내용은 직접 확인한 뒤 별도 환경에서 사용하세요. 이전 HTML 세션은 `app.html`로 복원됩니다.
- **LG EXAONE (K-EXAONE 2.5)**는 `k-exaone_v2.5`를 사용합니다. 제공자마다 키가 분리되며 생성 한도에는 추론 토큰이 포함됩니다. 서비스 혼잡 시 429가 표시될 수 있습니다. [EXAONE API 문서](https://docs.exaone.ai/ko/docs/k-exaone-2.5)

## 특허 심사품질 진단

1. **설정 → KIPRIS PLUS**에 본인의 키를 저장합니다. 상품 권한이 있는 출원번호로 연결을 검사합니다.
2. **특허 진단**에 13자리 특허·실용신안 출원번호를 입력하고 **서류 조회·다운로드**를 누릅니다. 저장된 PDF는 **열기**와 **PDF 다운로드**를 사용합니다. 파일의 추출·식별 상태는 버튼 위에 표시합니다. 저장 파일의 **텍스트 추출 재시도**는 로컬 파일을 사용하며, **원문 다시 조회**는 API에서 다운로드 주소를 다시 받습니다.
3. **진단 시작**을 누르면 전송할 LLM 주소와 모델이 표시됩니다. 동의 후 누락된 자료 조회를 시도하고 확보한 원문으로 검토합니다. 전송에 동의하지 않아도 조회와 다운로드를 이용할 수 있습니다.
4. 보고서는 문서별 상태, OA·RD·RC 규칙, 통지 당시 청구항 판본, 근거 쪽수와 미검토 범위를 보여줍니다. MD·TXT·JSON·PDF·HWPX로 저장할 수 있습니다. **이 출원 자료 삭제**로 로컬 기록과 원문을 지웁니다.

### 원문과 판정 범위

- 신규 기본 응답 상한은 30,000토큰입니다. 진단 호출마다 규칙 지시와 필요한 청구항 판본·문서 입력을 먼저 계산하고, 남은 공간과 모델 상한 내에서 출력 예산을 정합니다. 보고서에는 요청값과 호출별 적용 범위를 표시합니다. 기존에 저장된 상한은 설정에서 조정할 수 있습니다.
- 문서 전체가 들어가면 원문을 보내고, 한도를 넘으면 각 원문의 쪽별 관련 문구를 로컬에서 발췌합니다. 청구항 판본 전문은 유지합니다. 발췌로 검토한 규칙은 원문 인용을 대조하고, 생략 범위를 보고하며 전수 점검이나 발견 없음 판정은 보류합니다.
- AI 품질진단 시스템의 점검 항목을 기준으로 OA-01~17, RD-01~06, RC-01~07의 요약 규칙을 실행합니다. OA-15는 최후통지와 선행 통지, 당시 청구항 판본, 쟁점에 필요한 인용발명·명세서 등 원문을 대조합니다. 필요한 원문이나 검증 가능한 원문 인용이 빠지면 확인 불가로 표시합니다. OA-16·17은 통지 당시 청구항, RC-07은 검증된 등록청구항에 적용합니다.

- 행정처리 이력과 상품별 PDF 응답의 발송번호를 맞추고, 원문을 내려받아 페이지와 첫 쪽 식별자를 확인합니다. 경로 만료, PDF가 아닌 응답, 파일 손상, 텍스트 추출 실패, 식별자 불일치는 문서별로 표시합니다. 분석할 원문을 확인하지 못하면 외부 모델 호출 없이 진단을 보류합니다. 스캔 PDF의 OCR은 현재 범위에 없습니다.
- 변동 이력을 접수번호·일자로 대조해 통지 전 청구항을 복원합니다. 같은 날의 선후가 불명확하거나 원문을 확보하지 못한 판정은 보류합니다. 등록청구항은 등록공보와 대조합니다.
- 규칙별 LLM 결과는 원문에 존재하는 인용을 확인한 후 보조 판단으로 표시합니다. 공식 진단코드의 자동 확정과 외부 원문 없이는 판단할 수 없는 실체 결론은 보류합니다. 보정서·의견서·인용발명은 확인된 자동 제공 경로가 없어 수동 첨부를 사용합니다.
- 각 상품은 별도의 이용 권한이 필요할 수 있습니다. 원문을 외부 LLM으로 전송하기 전에 이용 조건과 전송 권한을 확인하세요. [KIPRIS PLUS 상품 목록](https://plus.kipris.or.kr/portal/data/apiClas/List.do) · [원문 이용 안내](https://plus.kipris.or.kr/portal/bbs/Faq_info.do?buttonIndex=&pageIndex=9)

## 개인정보와 검증

- 기본 설정은 웹 콘텐츠 인식과 기억 메모의 모델 전송을 끕니다. 일반 대화 전송 시 입력과 대화 맥락은 선택한 모델에 전송됩니다.
- KIPRIS PLUS 키는 LLM 키와 별도 로컬 저장소에 보관합니다. 일반 대화 내보내기에 키와 특허 진단 기록을 포함하지 않습니다.
- `npm ci && npm test`로 합성 자료 기반 테스트를 실행합니다. Chromium 통합 검증은 `npx playwright install chromium` 후 `npm run test:browser`로 실행합니다. 사용자의 실제 키나 문서는 테스트에 필요하지 않습니다.

MIT 라이선스입니다. [LICENSE](LICENSE)

### KIPRIS PLUS 문서별 자료

| 문서 | 공식 상품·오퍼레이션 | 조회 식별자 | 반환 자료와 연결 |
| --- | --- | --- | --- |
| 의견제출통지서·최후통지 | 의견제출통지서 `IntermediateDocumentOPService/pdfInfoV2` | 출원번호·발송번호 | PDF 주소 XML. 최후통지는 일치하는 발송번호의 PDF로 확인 |
| 거절결정서·등록결정서 | 거절결정서 `IntermediateDocumentREService/pdfInfoV2`, 등록결정서 `IntermediateDocumentRGService/pdfInfoV2` | 출원번호·발송번호 | PDF 주소 XML. 이력 및 원문 대조 |
| 공개·등록공보 | 특허·실용 공개·등록공보 `getPubFullTextInfoSearch`, `getAnnFullTextInfoSearch` | 출원번호, 응답과 첫 쪽의 공개·등록번호로 대조 | 공보 PDF 주소 XML. 각각 독립 조회. 표준화 전문은 같은 문서군의 별도 오퍼레이션 |
| 정정공보 | 특허·실용 공개·등록공보 `revisionfullDocPDFInfo` | 출원번호, 응답의 구분 코드·순번·일자 | PDF 주소 XML. 정정공보 행에 연결. 같은 일자에 여러 정정이 있을 때 PDF에서 순번 확인이 불가하면 검증 보류 |
| 최초 출원서·보정서·의견서 | 특허·실용 행정처리 이력 `relatedDocsonfileInfo`, 청구항 변동 이력 `amendmentHistoryInfo` / `amendmentHistoryDetailInfo` | 출원번호, 이력의 접수번호·순번 | 이력 XML 및 청구항 텍스트. 해당 상품에서 개별 원문 PDF 미제공 |
| 선행기술조사보고서·인용문헌 | 행정처리 이력, 특허·실용 공개·등록공보 `patentPriorArtDocumentsInfo`, 특허·실용 인용문헌 | 출원번호, 응답의 문헌번호 | 이력·문헌 식별정보. 조사보고서 원문은 이력 상품에서 미제공. 개별 인용문헌 원문은 문헌 종류별 제공 여부 확인 필요 |
| 심판 의견서·심판 보정서 | 특허·실용 행정처리 이력 및 심판사항 | 출원번호·심판번호, 이력의 접수번호 | 심판 이력 정보. 이력 상품에서 개별 의견서·보정서 원문 PDF 미제공 |
| 공개 심결문 | 심판사항 `applicationNumberSearchInfo` → `getJudDocumentInfoSearch` | 출원번호로 조회한 13자리 심판번호 | 공개 심결문의 PDF 주소 XML. 파일명·공개 여부·문서 종류를 대조하고 첫 쪽 사건번호로 검증 |

- 공식 자료는 [API 목록](https://plus.kipris.or.kr/portal/data/service/List.do?subTab=SC001&entYn=N&menuNo=200100), [API 상태](https://plus.kipris.or.kr/portal/main/apiStatus.do?menuNo=210157), [PDF 기능 안내](https://plus.kipris.or.kr/portal/bbs/view.do?bbsId=B0000004&nttId=611&pageIndex=1), [공보 상세](https://plus.kipris.or.kr/portal/data/service/DBII_000000000000001/view.do), [행정처리 이력](https://plus.kipris.or.kr/portal/data/clas/DBII_000000000000005/view.do?menuNo=210018), [청구항 변동 이력](https://plus.kipris.or.kr/portal/data/util/DBII_000000000000327/view.do?menuNo=210000&subTab=SC001), [인용문헌](https://plus.kipris.or.kr/portal/data/util/DBII_000000000000004/view.do?menuNo=210000&subTab=SC002), [심판사항](https://plus.kipris.or.kr/portal/data/clas/DBII_000000000000019/view.do?menuNo=210042)에서 확인할 수 있습니다.
