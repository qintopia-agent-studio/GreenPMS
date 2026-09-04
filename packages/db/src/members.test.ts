import { describe, expect, it } from "vitest";
import { projectMemberViewForRead } from "./members.ts";

describe("member read projection", () => {
  it("masks sensitive profile correction history without changing the current member or other audit facts", () => {
    const currentMember = {
      id: "member_current",
      full_name: "王晶晶",
      nickname: "晶晶",
      identity_card_number: "510000199001010022",
      phone: "13900000002",
      wechat: "jingjing-current"
    };
    const storedCorrection = {
      id: "profile_correction_1",
      prior_full_name: "王晶晶",
      prior_nickname: "晶晶旧昵称",
      prior_identity_card_number: "510000199001010011",
      prior_phone: "13800000001",
      prior_wechat: "jingjing-old",
      corrected_full_name: "王晶晶",
      corrected_nickname: "晶晶",
      corrected_identity_card_number: "510000199001010022",
      corrected_phone: "13900000002",
      corrected_wechat: "jingjing-current",
      changed_fields: ["nickname", "identityCardNumber", "phone", "wechat"],
      evidence_note: "纸质资料与本人确认一致",
      actor: { subjectId: "subject_admin", displayName: "运营管理员" }
    };

    const projected = projectMemberViewForRead({
      member: currentMember,
      profileCorrections: [storedCorrection],
      availableBalance: { ROOM_NIGHT: 30, BED_NIGHT: 0 }
    });

    expect(projected.member).toBe(currentMember);
    expect(projected.availableBalance).toEqual({ ROOM_NIGHT: 30, BED_NIGHT: 0 });
    expect(projected.profileCorrections).toEqual([{
      ...storedCorrection,
      prior_identity_card_number: "**************0011",
      prior_phone: "138****0001",
      prior_wechat: "j***ld",
      corrected_identity_card_number: "**************0022",
      corrected_phone: "139****0002",
      corrected_wechat: "j***nt"
    }]);
    expect(storedCorrection.prior_phone).toBe("13800000001");

    const correctionHistoryBody = JSON.stringify(projected.profileCorrections);
    for (const original of [
      storedCorrection.prior_identity_card_number,
      storedCorrection.prior_phone,
      storedCorrection.prior_wechat,
      storedCorrection.corrected_identity_card_number,
      storedCorrection.corrected_phone,
      storedCorrection.corrected_wechat
    ]) {
      expect(correctionHistoryBody).not.toContain(original);
    }
    const responseBody = JSON.stringify(projected);
    expect(responseBody).toContain(currentMember.identity_card_number);
    expect(responseBody).toContain(currentMember.phone);
    expect(responseBody).toContain(currentMember.wechat);
    expect(responseBody).toContain(storedCorrection.prior_nickname);
    expect(responseBody).toContain(storedCorrection.evidence_note);
  });

  it("does not reveal short sensitive history values in full", () => {
    const projected = projectMemberViewForRead({
      profileCorrections: [{
        prior_identity_card_number: "A12",
        prior_phone: "1234567",
        prior_wechat: "wx",
        corrected_identity_card_number: null,
        corrected_phone: "7654321",
        corrected_wechat: "abc"
      }]
    });

    expect(projected.profileCorrections[0]).toEqual({
      prior_identity_card_number: "****",
      prior_phone: "****",
      prior_wechat: "***",
      corrected_identity_card_number: null,
      corrected_phone: "****",
      corrected_wechat: "***"
    });
    expect(JSON.stringify(projected)).not.toMatch(/A12|1234567|wx|7654321|abc/);
  });
});
