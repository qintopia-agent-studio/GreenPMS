import { useState } from "react";
import type { ManagedRoom, RoomCatalogView } from "@qintopia/contracts";
import { Modal } from "../ui";

export type RoomCategoryDraft = { roomId?: string; buildingCode: string; included?: boolean };

export function RoomCategoryEditor({ data, draft, blocked, onClose, onSubmit }: {
  data: RoomCatalogView;
  draft: RoomCategoryDraft;
  blocked: boolean;
  onClose: () => void;
  onSubmit: (rooms: ManagedRoom[], included: boolean, draft: RoomCategoryDraft) => void;
}) {
  const buildings = [...new Set(data.rooms.map(room => room.buildingCode))];
  const [building, setBuilding] = useState(draft.buildingCode);
  const rooms = draft.roomId ? data.rooms.filter(room => room.unitId === draft.roomId)
    : data.rooms.filter(room => room.buildingCode === building);
  const commonCategory = (items: ManagedRoom[]) => items.length && items.every(room => room.includedInOperatingStatistics === items[0]!.includedInOperatingStatistics)
    ? items[0]!.includedInOperatingStatistics : undefined;
  const [included, setIncluded] = useState<boolean | undefined>(draft.included ?? commonCategory(rooms));
  const changes = rooms.filter(room => room.includedInOperatingStatistics !== included).length;
  const inactiveCount = rooms.filter(room => !room.active).length;

  return <Modal title={draft.roomId ? "修改房间分类" : "批量设置分类"} onClose={onClose}>
    <form className="catalog-form" onSubmit={event => {
      event.preventDefault();
      if (blocked || included === undefined || !rooms.length || !changes) return;
      onSubmit(rooms, included, { ...draft, buildingCode: building, included });
    }}>
      {draft.roomId ? <p className="catalog-category-target">{rooms[0]?.buildingCode}栋 · {rooms[0]?.code}</p>
        : <label className="field">选择楼栋<select value={building} onChange={event => {
          setBuilding(event.target.value);
          setIncluded(commonCategory(data.rooms.filter(room => room.buildingCode === event.target.value)));
        }}>{buildings.map(code => <option key={code} value={code}>{code ? `${code}栋` : "未分配楼栋"}</option>)}</select></label>}
      <fieldset className="catalog-category-options"><legend>房间分类</legend>
        <label className={included === true ? "is-selected" : ""}>
          <input type="radio" name="room-category" checked={included === true} onChange={() => setIncluded(true)} />
          <span><strong>经营单元</strong><small>计入经营入住率、住宿人数等统计</small></span>
        </label>
        <label className={included === false ? "is-selected" : ""}>
          <input type="radio" name="room-category" checked={included === false} onChange={() => setIncluded(false)} />
          <span><strong>非经营单元</strong><small>如员工宿舍，不计入上述统计</small></span>
        </label>
      </fieldset>
      <div className="catalog-category-impact">
        {!draft.roomId ? <p>本次设置覆盖该楼栋全部 {rooms.length} 间房{inactiveCount ? `（含 ${inactiveCount} 间已停用房间）` : ""}。</p> : null}
        <p>修改后，过去和今后的经营住宿统计都会按新分类计算。入住记录、订单和收付款照常保留。</p>
      </div>
      <footer className="catalog-category-footer"><button className="button button-secondary" type="button" onClick={onClose}>取消</button>
        <button className="button button-primary" type="submit" disabled={blocked || included === undefined || !rooms.length || !changes}>下一步：核对修改</button></footer>
    </form>
  </Modal>;
}
