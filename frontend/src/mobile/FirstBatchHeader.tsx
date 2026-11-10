import React from 'react';
import './first-batch.css';

/** The rings are decorative. Score diagrams and the navigation target keep their own palettes. */
export function FirstBatchHeader({eyebrow,title,description,meta,leading}:{
  eyebrow:string; title:React.ReactNode; description:string; meta?:React.ReactNode; leading?:React.ReactNode;
}) {
  return <header className="batch-header">
    {leading && <div className="batch-header-leading">{leading}</div>}
    <div className="batch-header-copy">
      <span className="batch-eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
      {meta && <div className="batch-header-meta">{meta}</div>}
    </div>
    <svg className="batch-target" viewBox="0 0 320 210" fill="none" aria-hidden="true" focusable="false">
      <g transform="translate(229 102) rotate(14) scale(.71 1)">
        <circle r="121" fill="#6e92ed" fillOpacity=".22"/>
        <circle r="106" fill="#f7f8ff" fillOpacity=".46"/>
        <circle r="86" fill="#677ce5" fillOpacity=".25"/>
        <circle r="68" fill="#f2fbff" fillOpacity=".67"/>
        <circle r="51" fill="#8698f3" fillOpacity=".5"/>
        <circle r="35" fill="#fff3e9" fillOpacity=".88"/>
        <circle r="20" fill="#eca77e" fillOpacity=".74"/>
        <circle r="6" fill="#f9dfb6"/>
      </g>
      <g stroke="#536cbb" strokeWidth="2.7" strokeLinecap="round">
        <path d="m65 50 163 53"/>
        <path d="m101 25 136 66" opacity=".56"/>
      </g>
      <g fill="#7494e7">
        <path d="m64 50-13-14 24 7 10 14z"/><path d="m64 50-17 4 23 8 15-5z"/>
        <path d="m103 26-9-12 17 7 8 13z" opacity=".75"/>
      </g>
    </svg>
  </header>;
}
