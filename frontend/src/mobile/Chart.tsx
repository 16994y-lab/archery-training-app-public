import React, { useEffect, useRef } from 'react';
import { init, use, type ComposeOption, type EChartsType } from 'echarts/core';
import { LineChart, BarChart, type LineSeriesOption, type BarSeriesOption } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, AriaComponent, type GridComponentOption, type TooltipComponentOption, type LegendComponentOption, type DataZoomComponentOption } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import './review.css';

use([LineChart,BarChart,GridComponent,TooltipComponent,LegendComponent,DataZoomComponent,AriaComponent,SVGRenderer]);
export type ChartOption = ComposeOption<LineSeriesOption|BarSeriesOption|GridComponentOption|TooltipComponentOption|LegendComponentOption|DataZoomComponentOption>;
export const chartColors = ['#123d78','#ea823d','#80b8e6'];
export function Chart({option,label,height=280,onSelect}:{option:ChartOption;label:string;height?:number;onSelect?:(index:number)=>void}) {
  const node=useRef<HTMLDivElement>(null), instance=useRef<EChartsType>(), selected=useRef(onSelect);
  selected.current=onSelect;
  useEffect(() => {
    const chart=init(node.current!,undefined,{renderer:'svg'});instance.current=chart;
    chart.on('click',params=>{if(typeof params.dataIndex==='number')selected.current?.(params.dataIndex);});
    const resize=()=>chart.resize();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(resize);observer?.observe(node.current!);window.addEventListener('resize',resize);
    return()=>{observer?.disconnect();window.removeEventListener('resize',resize);chart.dispose();instance.current=undefined;};
  },[]);
  useEffect(()=>{instance.current?.setOption({animation:false,color:chartColors,textStyle:{fontFamily:'sans-serif',color:'#264765'},...option},{notMerge:true});},[option]);
  return <div ref={node} className="review-chart" style={{height}} role="img" aria-label={label}/>;
}
