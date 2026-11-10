export type CompetitionLinkKind = 'notice'|'rules'|'entry'|'schedule'|'report'|'results';

export interface CompetitionEvent {
  id:string;
  name:string;
  level:string;
  province:string;
  city:string;
  year:number;
  checkedOn:string;
  links:readonly {kind:CompetitionLinkKind;label:string;url:string}[];
  venue?:string;
  startDate?:string;
  endDate?:string;
  month?:number;
  dateNote?:string;
  entryDeadline?:string;
  /** The organiser explicitly accepts individual entries from this date. */
  individualEntryFrom?:string;
  eligibility?:string;
  entryMethod?:string;
  entryNote?:string;
  format?:string;
  schedule?:readonly string[];
  reports?:readonly string[];
  result?:string;
}
