#!/usr/bin/env node
/**
 * 축제 데이터 수집 스크립트 — 한국관광공사 TourAPI (KorService2)
 *
 * 한 번 실행하면:
 *   1) 목록: 행사정보조회(searchFestival2)로 진행 중·곧 열릴 축제 목록을 전부 받는다(보통 몇 번 호출).
 *   2) 자세한 정보: 새로 생기거나 바뀐 축제만 골라 공통정보(detailCommon2, 소개글)와
 *      소개정보(detailIntro2, 운영 시간·요금·장소)를 남는 한도 안에서 조금씩 채운다.
 *   3) 추가 사진: 자세한 정보가 있는 축제의 사진 모음(detailImage2)을 채운다.
 *      공공누리 1·3유형 사진만 남긴다(3유형은 자르거나 고치지 않고 보여 줘야 한다).
 *      한 번 받은 정보는 data/festival-details.json 에 저장해 다시 부르지 않는다.
 *   3) 앱이 읽는 public/festivals.json 을 만든다.
 *
 * 한도 관리:
 *   - 기능마다 하루 1,000번(개발계정, 2026-11-17 신청서 화면 기준).
 *   - 오늘(한국 시간) 쓴 횟수를 data/tourapi-usage.json 에 적고, 기능마다 DAILY_CAP(기본 900)을 넘기지 않는다.
 *   - 한도 초과 응답이 오면 그 자리에서 멈추고, 받은 것까지만 저장한다.
 *
 * 쓰는 법:
 *   .env.local 에 TOURAPI_KEY=키 를 넣고  →  npm run fetch:festivals
 *   여러 번 돌려도 안전하다(1~3시간마다 돌리는 것을 권장).
 *
 * 환경 변수(선택):
 *   DAILY_CAP=900        기능별 하루 최대 호출 수
 *   DETAIL_PER_RUN=80    한 번 실행에서 자세한 정보를 채울 최대 축제 수
 *   FESTIVALS_OUT=public/festivals.json
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---- 설정 ------------------------------------------------------------------------

// 환경 변수가 없으면 프로젝트의 .env.local 에서 TOURAPI_KEY 한 줄을 읽는다.
// (.env.local 은 .gitignore의 *.local 에 걸려 커밋되지 않고, VITE_ 로 시작하지 않으니 앱 번들에도 안 들어간다.)
if (!process.env.TOURAPI_KEY && existsSync('.env.local')) {
  const line = readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .find((l) => /^\s*TOURAPI_KEY\s*=/.test(l));
  if (line) process.env.TOURAPI_KEY = line.replace(/^\s*TOURAPI_KEY\s*=\s*/, '').replace(/^["']|["']$/g, '');
}

const BASE = process.env.TOURAPI_BASE ?? 'https://apis.data.go.kr/B551011/KorService2';
const OUT = process.env.FESTIVALS_OUT ?? 'public/festivals.json';
const DETAILS_FILE = 'data/festival-details.json';
const USAGE_FILE = 'data/tourapi-usage.json';
const DAILY_CAP = Number(process.env.DAILY_CAP ?? 900);
const DETAIL_PER_RUN = Number(process.env.DETAIL_PER_RUN ?? 80);
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
// eventStartDate=오늘 로 부르면 이미 시작해 아직 진행 중인 축제까지 함께 온다(2026-11-17 실측: 오늘 기준 66건 = 진행 중·예정 전부).
// 그래서 과거로 거슬러 올라갈 필요가 없고, 목록은 보통 1번 호출로 끝난다.
const PAUSE_MS = 150; // 호출 사이 쉬는 시간

const rawKey = process.env.TOURAPI_KEY?.trim();
if (!rawKey) {
  console.error('TOURAPI_KEY가 없어요. .env.local 에 TOURAPI_KEY=받은키 한 줄을 넣어 주세요(docs/tourapi-key-guide.md 참고).');
  process.exit(1);
}
// 포털은 '인코딩 키'와 '디코딩 키'를 둘 다 준다. 어느 쪽이 와도 한 번만 인코딩되게 맞춘다.
const serviceKey = rawKey.includes('%') ? decodeURIComponent(rawKey) : rawKey;

// ---- 도움 함수 ----------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 한국 시간 기준 YYYY-MM-DD */
function kstDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function stripHtml(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value, pretty = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, pretty ? 2 : 0));
}

// ---- 한도 기록 ----------------------------------------------------------------------

const today = kstDate();
const usage = await readJson(USAGE_FILE, { date: today, counts: {} });
if (usage.date !== today) {
  usage.date = today;
  usage.counts = {};
}
const used = (op) => usage.counts[op] ?? 0;
const left = (op) => Math.max(0, DAILY_CAP - used(op));

class QuotaError extends Error {}

/** TourAPI 한 번 호출. 한도를 넘기려 하면 QuotaError. */
async function call(op, params) {
  if (left(op) <= 0) throw new QuotaError(`${op}: 오늘 쓸 수 있는 횟수(${DAILY_CAP})를 다 썼어요`);
  usage.counts[op] = used(op) + 1; // 실패해도 호출은 센다(포털도 센다고 보고 보수적으로)
  const qs = new URLSearchParams({ serviceKey, MobileOS: 'ETC', MobileApp: 'FestivalAlarm', _type: 'json', ...params });
  const res = await fetch(`${BASE}/${op}?${qs}`);
  const text = await res.text();
  await sleep(PAUSE_MS);
  // 공공데이터포털 오류는 _type=json 이어도 XML로 온다(활용매뉴얼 v4.4). returnReasonCode 로 원인을 알려 준다.
  const portalCode = text.match(/<returnReasonCode>(\d+)<\/returnReasonCode>/)?.[1];
  if (portalCode === '22' || /LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(text)) throw new QuotaError(`${op}: 공공데이터포털 하루 한도 초과(22)`);
  if (portalCode) {
    const why = {
      '12': '없거나 폐기된 서비스',
      '20': '서비스 접근 거부(활용신청한 상세기능인지 확인)',
      '30': '등록되지 않은 키(신청 직후면 10분쯤 기다리기, 키를 다시 복사하기)',
      '31': '활용 기간 만료(마이페이지에서 연장 신청)',
      '32': '등록되지 않은 IP',
    }[portalCode] ?? '기타 오류';
    throw new Error(`${op}: 공공데이터포털 오류 ${portalCode} — ${why}`);
  }
  if (!res.ok) throw new Error(`${op}: HTTP ${res.status}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 키 오류 등은 XML로 오는 경우가 있다. 키가 섞이지 않게 앞부분만 보여 준다.
    throw new Error(`${op}: JSON이 아닌 응답: ${text.slice(0, 200).split(serviceKey).join('***')}`);
  }
  const header = json?.response?.header;
  if (header?.resultCode === '22') throw new QuotaError(`${op}: 하루 한도 초과(22)`);
  if (header?.resultCode !== '0000') throw new Error(`${op}: TourAPI 오류 ${header?.resultCode} ${header?.resultMsg}`);
  const body = json.response.body;
  const raw = body?.items?.item ?? [];
  return { items: Array.isArray(raw) ? raw : [raw], total: Number(body?.totalCount ?? 0) };
}

// ---- 1) 목록 -------------------------------------------------------------------------

const now = new Date();
now.setHours(0, 0, 0, 0);
const todayYmd = ymd(now);

let listItems = [];
let listOk = true;
try {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, total } = await call('searchFestival2', {
      eventStartDate: todayYmd,
      numOfRows: String(PAGE_SIZE),
      pageNo: String(page),
      arrange: 'C',
    });
    listItems.push(...items);
    if (listItems.length >= total || items.length === 0) break;
  }
} catch (e) {
  listOk = false;
  console.error(`목록을 다 받지 못했어요: ${e.message}`);
}

const previous = await readJson(OUT, null);
if (!listOk && previous?.items?.length) {
  // 목록이 중간에 끊기면 반쪽짜리 파일로 덮어쓰지 않고, 지난 목록을 그대로 쓴다.
  console.error('지난번 목록을 그대로 둘게요.');
  listItems = previous.items;
}

const active = listItems
  .filter((it) => String(it.eventenddate ?? '') >= todayYmd) // 이미 끝난 축제는 뺀다
  .map((it) => ({
    contentid: String(it.contentid),
    contenttypeid: String(it.contenttypeid ?? '15'),
    title: it.title,
    addr1: it.addr1 ?? '',
    addr2: it.addr2 ?? '',
    eventstartdate: String(it.eventstartdate),
    eventenddate: String(it.eventenddate),
    mapx: it.mapx,
    mapy: it.mapy,
    tel: it.tel ?? '',
    modifiedtime: String(it.modifiedtime ?? ''),
    // 분류(EV01 축제 / EV02 공연 / EV03 행사 — 신분류체계 정의서)와 대표 이미지·저작권 유형(Type1/Type3)
    lclsSystm1: it.lclsSystm1 ?? '',
    lclsSystm2: it.lclsSystm2 ?? '',
    lclsSystm3: it.lclsSystm3 ?? '',
    firstimage: it.firstimage ?? '',
    cpyrhtDivCd: it.cpyrhtDivCd ?? '',
  }));

// ---- 2) 자세한 정보(새로 생기거나 바뀐 것만, 남는 한도 안에서) ----------------------------

const details = await readJson(DETAILS_FILE, {});
const activeIds = new Set(active.map((f) => f.contentid));
for (const id of Object.keys(details)) if (!activeIds.has(id)) delete details[id]; // 끝난 축제 정보는 정리

const need = active
  .filter((f) => !details[f.contentid] || details[f.contentid].modifiedtime !== f.modifiedtime)
  // 곧 열리거나 진행 중인 축제부터 채운다
  .sort((a, b) => Math.max(Number(a.eventstartdate), Number(todayYmd)) - Math.max(Number(b.eventstartdate), Number(todayYmd)));

let filled = 0;
let stopReason = '';
for (const f of need) {
  if (filled >= DETAIL_PER_RUN) {
    stopReason = `한 번에 채우는 수(${DETAIL_PER_RUN})만큼 채웠어요`;
    break;
  }
  try {
    const common = await call('detailCommon2', { contentId: f.contentid });
    const intro = await call('detailIntro2', { contentId: f.contentid, contentTypeId: f.contenttypeid || '15' });
    const c = common.items[0] ?? {};
    const i = intro.items[0] ?? {};
    details[f.contentid] = {
      modifiedtime: f.modifiedtime,
      overview: stripHtml(c.overview),
      homepage: '', // 외부 링크는 앱에 넣지 않는다(앱인토스 외부 링크 제한)
      eventplace: stripHtml(i.eventplace),
      playtime: stripHtml(i.playtime),
      usetimefestival: stripHtml(i.usetimefestival),
      sponsor1: stripHtml(i.sponsor1),
      agelimit: stripHtml(i.agelimit),
      fetchedAt: new Date().toISOString(),
    };
    filled++;
  } catch (e) {
    if (e instanceof QuotaError) {
      stopReason = e.message;
      break;
    }
    console.error(`자세한 정보를 못 받았어요(${f.title}): ${e.message}`);
  }
}

// ---- 2-2) 추가 사진 ---------------------------------------------------------------------
const MAX_IMAGES = 12;
let imgFilled = 0;
if (!stopReason) {
  for (const f of active) {
    const d = details[f.contentid];
    if (!d || Array.isArray(d.images)) continue;
    if (imgFilled >= DETAIL_PER_RUN) break;
    try {
      const r = await call('detailImage2', { contentId: f.contentid, imageYN: 'Y', numOfRows: '30', pageNo: '1' });
      d.images = r.items
        .filter((x) => x && (x.cpyrhtDivCd === 'Type1' || x.cpyrhtDivCd === 'Type3') && x.originimgurl)
        .map((x) => ({
          url: String(x.originimgurl).replace(/^http:\/\//, 'https://'),
          license: x.cpyrhtDivCd,
          name: stripHtml(x.imgname ?? ''),
        }))
        .slice(0, MAX_IMAGES);
      imgFilled++;
    } catch (e) {
      if (e instanceof QuotaError) {
        stopReason = e.message;
        break;
      }
      console.error(`추가 사진을 못 받았어요(${f.title}): ${e.message}`);
    }
  }
}

// ---- 3) 저장 ---------------------------------------------------------------------------

const merged = active.map((f) => {
  const d = details[f.contentid];
  return d
    ? {
        ...f,
        overview: d.overview,
        eventplace: d.eventplace,
        playtime: d.playtime,
        usetimefestival: d.usetimefestival,
        sponsor1: d.sponsor1,
        agelimit: d.agelimit,
        images: d.images ?? [],
      }
    : f;
});

await writeJson(DETAILS_FILE, details);
await writeJson(USAGE_FILE, usage, true);
await writeJson(OUT, {
  updatedAt: listOk ? new Date().toISOString() : (previous?.updatedAt ?? new Date().toISOString()),
  source: '한국관광공사 TourAPI 국문 관광정보 서비스',
  items: merged,
});

const withDetail = merged.filter((f) => details[f.contentid]).length;
console.log(`축제 ${merged.length}곳 저장 → ${OUT}`);
console.log(`추가 사진: 이번에 ${imgFilled}곳 채움`);
console.log(`자세한 정보: 이번에 ${filled}곳 채움, 모두 ${withDetail}/${merged.length}곳 채워짐${stopReason ? ` (멈춘 이유: ${stopReason})` : ''}`);
console.log(
  `오늘(${today}) 쓴 횟수: 목록 ${used('searchFestival2')}, 공통정보 ${used('detailCommon2')}, 소개정보 ${used('detailIntro2')}, 추가 사진 ${used('detailImage2')} / 기능별 최대 ${DAILY_CAP}`,
);
