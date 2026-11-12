// Review criteria written for this extension from the supplied diagnostic workflow.
const PatentRules = (() => {
  const groups = {
    OA: [
      ['01', '주문과 세부 이유의 대상 청구항 집합을 이유별로 비교'],
      ['02', '주문과 세부 이유의 적용 조문 및 거절이유 유형을 비교'],
      ['03', '청구항별 인용문헌의 단독·결합 관계와 그 변경 근거를 비교'],
      ['04', '본문과 첨부 목록의 실제 문헌 번호 및 역할을 대조'],
      ['05', '명확성 지적이 단순 표현 선호인지 청구항의 해석에 영향을 주는지 확인', 'claims'],
      ['06', '이유마다 대상, 근거, 논증과 결론이 연결되는지 확인'],
      ['07', '제조방법으로 특정한 물건 청구항과 인용문헌의 물건 및 제조 경로를 비교. 통지서와 검증된 인용발명 원문에서 각각 대조 근거를 인용', 'external'],
      ['08', '실시 가능성과 청구항 명확성의 근거 및 해당 조문이 일치하는지 확인', 'external'],
      ['09', '의약용도 청구항의 질병 및 약리 효과 특정 여부를 검토', 'external'],
      ['10', '물건의 종류를 택일한 문언이 청구항의 기재 방식에 미치는 영향을 검토', 'claims'],
      ['11', '경화물 표현의 선행기재와 청구항 전체의 종속관계를 확인', 'claims'],
      ['12', '임의로 포함한다는 표현의 선택성 및 종속관계를 확인', 'claims'],
      ['13', '조합·결합이 문맥에서 어떤 역할인지 확인하고 용어 혼용과 논증 누락을 구별'],
      ['14', '통지서만으로 고칠 수 있는 단순오기를 제외하고 외부 원문이 필요한 오기를 구별']
    ],
    RD: [
      ['01', '결정의 조문 및 독립 거절이유를 모든 선행 통지와 비교', 'notices'],
      ['02', '대상항, 실제 문헌 번호 및 결합 역할의 변경을 모든 선행 통지와 비교', 'notices'],
      ['03', '불리한 핵심 사실이나 논리가 새로 추가됐는지 상세화와 구별', 'notices'],
      ['04', '거절결정 내부에서 근거·논증·결론이 연결되는지 확인'],
      ['05', '최후통지를 포함한 선행 통지 전부에서 결정의 각 핵심 근거를 찾음', 'notices'],
      ['06', '의견서 또는 결정이 명시적으로 인용한 핵심 주장의 검토 여부를 확인']
    ],
    RC: [
      ['01', '종속항 인용 번호의 존재와 앞선 청구항 인용 여부를 확인'],
      ['02', '복수 인용의 택일성과 복수 인용 종속항의 중첩 여부를 확인'],
      ['03', '청구항 번호 순서와 독립·종속항 구분 및 기재 단위를 확인'],
      ['04', '선행기재, 용어, 지시 대상과 보호 범위의 명확성을 확인'],
      ['05', '기능 및 작동 한정의 내부 정합성을 확인'],
      ['06', '단순 문법·표현과 실질적 불명확성을 구분']
    ]
  };

  const compact = text => String(text || '').normalize('NFKC').replace(/\s/g, '');
  const failure = reason => ({ status: 'unavailable', reason, steps: [], claims: [] });

  function claimReferences(text) {
    const refs = new Set();
    for (const match of text.matchAll(/제\s*(\d+)\s*항\s*(?:내지|부터|~|∼|〜|[-–])\s*제?\s*(\d+)\s*항/g)) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (end < start || end - start > 500) return null;
      for (let i = start; i <= end; i++) refs.add(i);
    }
    for (const match of text.matchAll(/제\s*(\d+)\s*항/g)) refs.add(Number(match[1]));
    return [...refs].sort((a, b) => a - b);
  }

  function restoreClaims(history, rows, target) {
    if (!history?.events?.length || !history.changes?.length || !target.date) return failure('청구항 변동 이력 또는 기준일 없음');
    if (rows.some(row => row.kind === 'AM' && row.date === target.date)) return failure('통지와 보정이 같은 날이라 선후 관계 미확인');
    const events = history.events.filter(row => row.date < target.date)
      .sort((a, b) => a.date.localeCompare(b.date) || Number(a.serial) - Number(b.serial));
    if (!events.length || !/^(?:(?:특허|실용신안)?출원서|국내단계|국내서면|번역문|최초출원|국내출원)/.test(Kipris.normalizedTitle(events[0].title))) {
      return failure('최초 출원 또는 국내단계 청구항 근거 없음');
    }
    if (history.events.some(row => !row.date || row.date === target.date)
        || events.some(row => !row.id || !/^\d+$/.test(row.serial))
        || new Set(events.map(row => row.serial)).size !== events.length) {
      return failure('접수일·접수번호·순서 검증 불가');
    }
    const byNumber = new Map(rows.map(row => [row.id, row]));
    if (events.some(event => !byNumber.has(event.id) || byNumber.get(event.id).date !== event.date)
      || rows.some(row => row.kind === 'AM' && row.date < target.date && !events.some(event => event.id === row.id))
      || history.changes.some(change => !history.events.some(event => event.serial === change.serial && event.id === change.id))) {
      return failure('행정처리 이력의 접수번호 또는 날짜와 불일치');
    }
    const claims = new Map();
    for (const event of events) {
      const seen = new Set();
      const changes = history.changes.filter(change => change.serial === event.serial);
      if (!changes.length) return failure(`접수 ${event.id}의 청구항 상세 누락`);
      for (const change of changes) {
        const id = Number(change.claim.match(/^(?:제\s*)?(\d+)\s*(?:항)?$/)?.[1]);
        const operation = change.change.trim();
        const exists = claims.has(id);
        if (!id || seen.has(id) || change.id !== event.id || (change.date && change.date !== event.date)
            || !['신규', '수정', '삭제'].includes(operation) || (operation === '신규') === exists
            || (operation !== '삭제' && !change.text.trim())) return failure('청구항 상세의 번호·연산·전문 검증 실패');
        seen.add(id);
        if (operation === '삭제') claims.delete(id);
        else claims.set(id, change.text);
      }
    }
    const result = [...claims].sort(([a], [b]) => a - b)
      .map(([id, text]) => ({ id, text, references: claimReferences(text) }));
    if (!result.length || result.some(claim => !claim.references || claim.references.some(id => id >= claim.id || !claims.has(id)))) {
      return failure('복원 후 인용관계에 누락 또는 순서 오류가 있음');
    }
    return { status: 'reconstructed', asOf: events.at(-1).date, basis: target.date, steps: events, claims: result,
      reason: '통지 이전의 접수·보정 이력 기준. 통지서에 인용된 문언은 별도 대조 필요.' };
  }

  function verifyRegisteredClaims(raw, gazette, rows) {
    if (!Array.isArray(raw) || !raw.length || gazette?.status !== 'verified') return failure('등록공보와 청구항 API가 모두 필요함');
    if (rows.some(row => row.kind === 'CORRECTION' || row.kind === 'RD')) return failure('정정 또는 거절·등록 경과의 기준 시점 확인 필요');
    const full = gazette.pages.map(page => page.text).join('\n');
    const count = Number(full.match(/(?:전체|총)\s*청구항\s*(?:수\s*[:：]?)?\s*(?:총\s*)?(\d+)\s*항?/)?.[1]);
    const registeredAt = full.match(/(?:\(24\)\s*)?등\s*록\s*일\s*자\s*[:：]?\s*(\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}[.-]\d{2}[.-]\d{2})/)?.[1];
    const registration = full.match(/(?:\(11\)\s*)?등\s*록\s*번\s*호\s*[:：]?\s*(\d{2}[-\s]*\d{7})/)?.[1];
    if (!count || count !== raw.length || !registeredAt || !registration) {
      return failure('등록번호·일자·청구항 수를 공보에서 교차 확인하지 못함');
    }

    const comparable = text => text.normalize('NFC').replace(/\s/g, '');
    const contents = gazette.pages.map(page => {
      const lines = page.text.trim().split(/\r?\n/);
      if (comparable(lines[0]) === '등록특허' + comparable(registration)) lines.shift();
      if (lines.length && comparable(lines.at(-1)) === '-' + page.page + '-') lines.pop();
      return lines.join('\n');
    }).join('\n');
    const claimHeading = /^[\t ]*청[\t ]*구[\t ]*항[\t ]*(\d+)(?=[\t :：\r\n]|$)[\t ]*[:：]?[\t ]*/gm;
    const first = claimHeading.exec(contents);
    if (!first) return failure('등록공보의 청구항 경계를 식별하지 못함');
    const excerpt = contents.slice(first.index)
      .split(/^[\t ]*(?:\[[\t ]*)?(?:발명의[\t ]*설명|도면|서열목록)(?:[\t ]*\])?[\t ]*\r?$/m, 1)[0];
    claimHeading.lastIndex = 0;
    const boundaries = [...excerpt.matchAll(claimHeading)];
    const gazetteClaims = new Map();
    for (const [index, heading] of boundaries.entries()) {
      const id = Number(heading[1]);
      const text = excerpt.slice(heading.index + heading[0].length, boundaries[index + 1]?.index);
      if (!Number.isSafeInteger(id) || id < 1 || gazetteClaims.has(id) || !comparable(text)) {
        return failure('등록공보의 청구항 번호 또는 전문을 식별하지 못함');
      }
      gazetteClaims.set(id, comparable(text));
    }
    if (gazetteClaims.size !== count) return failure('등록공보의 청구항 번호 또는 전문을 식별하지 못함');

    const claims = new Map();
    for (const [index, entry] of raw.entries()) {
      const rawText = typeof entry === 'string' ? entry : entry?.text;
      if (typeof rawText !== 'string') return failure('청구항 API의 전문을 식별하지 못함');
      const number = typeof entry === 'object' ? entry?.number : null;
      // A claim's body can itself begin with a reference such as "청구항 1".
      const matchesWithoutLabel = gazetteClaims.get(Number(number ?? index + 1)) === comparable(rawText);
      const label = matchesWithoutLabel ? null
        : rawText.match(/^\s*(?:청\s*구\s*항\s*(\d+)(?=\s|[:：]|$)\s*[:：]?|제\s*(\d+)\s*항\s*[:：])\s*/);
      const labelNumber = label ? Number(label[1] || label[2]) : null;
      const id = Number(number ?? labelNumber ?? index + 1);
      const text = rawText.slice(label?.[0].length ?? 0).trim();
      if ((labelNumber !== null && id !== labelNumber) || claims.has(id)
        || !comparable(text) || gazetteClaims.get(id) !== comparable(text)) {
        return failure('청구항 번호별 API 전문과 등록공보 문언이 일치하지 않음');
      }
      claims.set(id, { id, text, references: claimReferences(text) });
    }
    return { status: 'verified', registration, registeredAt, claims: [...claims.values()].sort((a, b) => a.id - b), reason: '' };
  }

  function registeredFindings(target, version) {
    if (version.status !== 'verified') return [];
    const ids = new Set(version.claims.map(claim => claim.id));
    const findings = [];
    for (const claim of version.claims) {
      const invalid = claim.references?.filter(id => id >= claim.id || !ids.has(id)) || [];
      if (!invalid.length) continue;
      const page = target.pages.find(item => compact(item.text).includes(compact(claim.text)));
      if (!page) continue;
      findings.push({ rule: 'RC-01', target: target.id, level: '명백한 불일치', code: null,
        evidence: [{ document: target.id, page: page.page, quote: claim.text }],
        comparison: `제${claim.id}항과 등록공보에 존재하는 청구항 번호 및 순서를 비교했습니다.`,
        analysis: `인용 번호 ${invalid.join(', ')}는 앞선 유효 청구항에 해당하지 않습니다.`,
        verdict: '인용 번호 또는 청구항 순서 확인 필요' });
    }
    return findings;
  }

  function readFindings(raw, rules, evidence, target) {
    const parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(parsed)) throw new Error('모델이 규칙별 JSON 배열을 반환하지 않았습니다.');
    const rows = [];
    for (const [rule] of rules) {
      const matches = parsed.filter(item => item?.rule === rule);
      if (matches.length !== 1) continue;
      const item = matches[0];
      if (!['조건부 점검', '검토한 규칙에서 발견되지 않음', '확인 불가'].includes(item.level)) continue;
      const fields = ['comparison', 'analysis', 'verdict'];
      if (fields.some(field => typeof item[field] !== 'string' || !item[field].trim() || item[field].length > 1600)) continue;
      if (!Array.isArray(item.evidence)) continue;
      const refs = item.evidence.slice(0, 6).filter(ref => typeof ref?.quote === 'string'
        && compact(ref.quote).length >= 5 && ref.quote.length <= 1200
        && evidence.some(document => document.id === ref.document
          && document.pages.some(page => page.page === ref.page && compact(page.text).includes(compact(ref.quote)))));
      if (item.level !== '확인 불가' && (!refs.length || !refs.some(ref => ref.document === target))) continue;
      if (item.level !== '확인 불가' && rule === 'OA-07'
        && !evidence.some(doc => doc.id !== target && doc.kind === 'CITATION' && doc.status === 'verified'
          && refs.some(ref => ref.document === doc.id))) continue;
      if (item.level !== '확인 불가' && ['RD-01', 'RD-02', 'RD-03', 'RD-05'].includes(rule)
        && !refs.some(ref => ref.document !== target)) continue;
      rows.push({ rule, target, level: item.level, code: null, evidence: refs,
        comparison: item.comparison, analysis: item.analysis, verdict: item.verdict });
    }
    return rows;
  }

  return { groups, restoreClaims, verifyRegisteredClaims, registeredFindings, readFindings };
})();
