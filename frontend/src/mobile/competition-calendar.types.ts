export type CompetitionLinkKind = 'notice'|'rules'|'entry'|'schedule'|'spectator'|'broadcast'|'report'|'results';

export interface CompetitionEvent {
  id:string;
  name:string;
  level:string;
  province:string;
  city:string;
  country?:string;
  year:number;
  checkedOn:string;
  links:readonly {kind:CompetitionLinkKind;label:string;url:string}[];
  venue?:string;
  startDate?:string;
  endDate?:string;
  month?:number;
  dateNote?:string;
  entryDeadline?:string;
  entryDeadlineZone?:'UTC';
  /** The organiser explicitly accepts individual entries from this date. */
  individualEntryFrom?:string;
  eligibility?:string;
  eligibilitySummary?:string;
  entryMethod?:string;
  entryNote?:string;
  spectator?:{
    status?:'免费入场'|'购票入场'|'预约入场'|'不对公众开放';
    admission:string;
    broadcast:string;
    /** A verified live viewing channel, rather than a general event announcement. */
    liveStream?:string;
  };
  format?:string;
  schedule?:readonly string[];
  reports?:readonly string[];
  result?:string;
}
