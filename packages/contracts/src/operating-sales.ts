export type OperatingSalesSource = "DIRECT" | "MEMBERSHIP" | "CHANNEL" | "BASELINE";
export interface OperatingSalesAmount { currency:string; salesMinor:string|null; refundsMinor:string|null; correctedMinor:string; netMinor:string }
export interface OperatingSalesSummary {
 enabled:boolean; complete:boolean; reason:string; reviewCount:number;
 totals:OperatingSalesAmount[];
 breakdown:Array<OperatingSalesAmount & {source:OperatingSalesSource}>;
 trend:Array<{date:string;totals:OperatingSalesAmount[]}>;
 sealedMonths:string[];
}
