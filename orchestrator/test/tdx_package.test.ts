/**
 * 通达信盘后包解析测试。
 *
 * 🔴 这份测试护的是「**价格是 double，不是 32 位定点**」这条 ——
 *    按老式 .day 的 32 字节/条格式去读，会得到一堆看起来像 f32 的乱码而且不报错，
 *    最后算出来的涨跌幅全是错的。所以这里用**合成的 zip** 把偏移全部钉死。
 *
 * 另外护两件事：
 *   ① 行情块要按 .cod 里的 `seq` 定位，不是按顺序 —— 两者乱序就会张冠李戴；
 *   ② `close <= 0` 是当日无价（880/881 自编指数、停牌），必须跳过，不能当 0% 计入广度。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { readZipEntries, parsePackageZip, ymdOf, isAStock, marketBreadthOf, type PackageDay } from "../src/finance/tdx_package.ts";

/** 造一个最小 zip（store 方式，不校验 CRC —— 解析器本来也不校验） */
function makeZip(files: Record<string, Buffer>, deflate = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const n = Object.keys(files).length;
  eocd.writeUInt16LE(n, 8);
  eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

interface Spec { code: string; seq: number; prevClose: number; close: number }

/** 按真实格式拼一对 .cod/.md1：cod 150B/条、md1 512B/块 */
function marketFiles(market: string, ymd: string, specs: Spec[], blocks = specs.length): Record<string, Buffer> {
  const cod = Buffer.alloc(specs.length * 150);
  specs.forEach((s, i) => {
    cod.write(s.code, i * 150, "ascii");
    cod.writeUInt16LE(s.seq, i * 150 + 32);
  });
  const md1 = Buffer.alloc(blocks * 512);
  for (const s of specs) {
    md1.writeDoubleLE(s.prevClose, s.seq * 512 + 4);
    md1.writeDoubleLE(s.close, s.seq * 512 + 36);
    md1.writeDoubleLE(1e8, s.seq * 512 + 72);
  }
  return { [`${market}${ymd}.cod`]: cod, [`${market}${ymd}.md1`]: md1 };
}

/** 凑够「有价记录下限」，否则解析器会按残缺文件抛错 */

describe("readZipEntries 中央目录解析", () => {
  it("store 与 deflate 两种都能读", () => {
    const files = { "a.txt": Buffer.from("hello"), "b.bin": Buffer.from([1, 2, 3, 4]) };
    for (const deflate of [false, true]) {
      const got = readZipEntries(makeZip(files, deflate));
      assert.equal(got.get("a.txt")!.toString(), "hello");
      assert.deepEqual([...got.get("b.bin")!], [1, 2, 3, 4]);
    }
  });

  it("不是 zip 要抛错，不能静默返回空表", () => {
    assert.throws(() => readZipEntries(Buffer.from("PK-but-garbage")), /中央目录/);
  });
});

describe("parsePackageZip 盘后包解析", () => {
  const ymd = "261029";

  function build(): Buffer {
    return makeZip({
      ...marketFiles("sh", ymd, [
        { code: "600519", seq: 0, prevClose: 100, close: 110 },
        { code: "601318", seq: 1, prevClose: 50, close: 47.5 },
        { code: "000001", seq: 2, prevClose: 10, close: 10 },     // 与深市同号，靠市场前缀区分
        ...Array.from({ length: 1000 }, (_, i) => ({
          code: String(700000 + i).padStart(6, "0"), seq: 3 + i, prevClose: 10, close: 10,
        })),
      ]),
      ...marketFiles("sz", ymd, [
        { code: "000001", seq: 0, prevClose: 20, close: 21 },
        ...Array.from({ length: 1000 }, (_, i) => ({
          code: String(100 + i).padStart(6, "0"), seq: 1 + i, prevClose: 10, close: 10,
        })),
      ]),
      ...marketFiles("bj", ymd, [
        ...Array.from({ length: 100 }, (_, i) => ({ code: String(830000 + i), seq: i, prevClose: 10, close: 10 })),
      ]),
    });
  }

  it("涨跌幅按 double 算对，保留 3 位小数", () => {
    const day = parsePackageZip(build(), "2026-10-29");
    assert.equal(day.date, "2026-10-29");
    assert.equal(day.chg.get("sh600519"), 10, "100 → 110 是 +10%");
    assert.equal(day.chg.get("sh601318"), -5, "50 → 47.5 是 −5%");
    assert.equal(day.chg.get("sz000001"), 5, "深市 000001 20 → 21 是 +5%");
    assert.equal(day.chg.get("sh000001"), 0, "沪市 000001 不是深市那只，必须分开存");
  });

  it("行情块按 seq 定位，不是按 .cod 顺序", () => {
    // 把 600519 放到 seq=1001（生成记录用 0..999），若按顺序读就会读成第 0 块
    const zip = makeZip({
      ...marketFiles("sh", ymd, [
        { code: "600519", seq: 1001, prevClose: 100, close: 120 },
        ...Array.from({ length: 1000 }, (_, i) => ({ code: String(700000 + i), seq: i, prevClose: 10, close: 10 })),
      ], 1002),
      ...marketFiles("sz", ymd, [
        ...Array.from({ length: 1000 }, (_, i) => ({ code: String(100 + i).padStart(6, "0"), seq: i, prevClose: 10, close: 10 })),
      ]),
    });
    const day = parsePackageZip(zip, "2026-10-29");
    assert.equal(day.chg.get("sh600519"), 20, "+20% 落在 seq=1001 那块，不是第 0 块");
  });

  it("close <= 0 的块跳过（当日无价，不是 0%）", () => {
    const zip = makeZip({
      ...marketFiles("sh", ymd, [
        { code: "600519", seq: 0, prevClose: 100, close: 0 },
        ...Array.from({ length: 1000 }, (_, i) => ({ code: String(700000 + i), seq: 1 + i, prevClose: 10, close: 10 })),
      ]),
      ...marketFiles("sz", ymd, [
        ...Array.from({ length: 1000 }, (_, i) => ({ code: String(100 + i).padStart(6, "0"), seq: i, prevClose: 10, close: 10 })),
      ]),
    });
    const day = parsePackageZip(zip, "2026-10-29");
    assert.equal(day.chg.has("sh600519"), false, "无价记录不能当成 0% 混进广度");
  });

  it("缺沪深任一市场文件要抛错（半截包不能当全市场）", () => {
    const zip = makeZip({
      ...marketFiles("sh", ymd, Array.from({ length: 1000 }, (_, i) => ({
        code: String(700000 + i), seq: i, prevClose: 10, close: 10,
      }))),
    });
    assert.throws(() => parsePackageZip(zip, "2026-10-29"), /缺 sz/);
  });

  it("有价记录少于下限要抛错", () => {
    const zip = makeZip({
      ...marketFiles("sh", ymd, [{ code: "600519", seq: 0, prevClose: 100, close: 110 }]),
      ...marketFiles("sz", ymd, [{ code: "000001", seq: 0, prevClose: 20, close: 21 }]),
    });
    assert.throws(() => parsePackageZip(zip, "2026-10-29"), /有价记录/);
  });
});

describe("ymdOf 本地日期", () => {
  it("用本地日期，不是 UTC（东八区晚上会差一天）", () => {
    assert.equal(ymdOf(new Date(2026, 9, 29, 23, 30)), "2026-10-29");
    assert.equal(ymdOf(new Date(2026, 0, 1, 0, 5)), "2026-01-01");
  });
});

/**
 * 🔴 这份测试护的是「全市场基准只算 A 股」。
 *    一份盘后包 5.2 万行里绝大多数是基金/债券/指数，它们大量平盘（close == prev_close），
 *    混进去会把上涨占比硬锚在 50% 附近 —— 实测剃干净后 8 个交易日区间是 9.6%~81.2%，
 *    混进去就永远是 45%~55%，看不出任何东西。
 */
describe("isAStock 只算 A 股股票", () => {
  it("沪深主板 / 创业板 / 科创板 / 北交所都算", () => {
    for (const k of ["sh600519", "sh601318", "sh603288", "sh605499", "sh688981", "sh689009",
                     "sz000001", "sz001979", "sz002594", "sz003816", "sz300750", "sz301269",
                     "bj430047", "bj830799", "bj871981", "bj920000"]) {
      assert.equal(isAStock(k), true, `${k} 是 A 股`);
    }
  });

  it("ETF / LOF / 债券 / 逆回购 / 指数都不算", () => {
    for (const k of ["sh510300", "sz159915", "sh113050", "sz128136", "sh204001", "sz131810",
                     "sh000001", "sz399001", "sh880001"]) {
      assert.equal(isAStock(k), false, `${k} 不是 A 股`);
    }
  });
});

describe("marketBreadthOf 全市场宽度", () => {
  const day = (rows: Record<string, number>): PackageDay =>
    ({ date: "2026-10-29", chg: new Map(Object.entries(rows)), priced: Object.keys(rows).length });

  it("只统计 A 股，平盘的基金不参与", () => {
    const b = marketBreadthOf(day({
      sh600000: 1, sh600519: 2, sz000001: -1,          // 2 涨 1 跌
      sh510300: 0, sh510500: 0, sh113050: 0, sh204001: 0,   // 平盘的基金/债券/逆回购
    }))!;
    assert.equal(b.n, 3, "只数 3 只 A 股");
    assert.equal(b.up_rate, 0.6667, "2/3，不是 2/7");
    assert.equal(b.median, 1);
  });

  it("中位数用真中位数（偶数取中间两个平均）", () => {
    const b = marketBreadthOf(day({ sh600000: -5, sh600519: 1, sz000001: 3, sz300750: 9 }))!;
    assert.equal(b.median, 2, "(-5,1,3,9) → (1+3)/2");
  });

  it("一只 A 股都没有时返回 null，不拿 0 冒充", () => {
    assert.equal(marketBreadthOf(day({ sh510300: 0 })), null);
  });
});
