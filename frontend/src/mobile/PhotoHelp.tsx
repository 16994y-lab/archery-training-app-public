import React from 'react';
import {Button,Modal} from './ui';
import './photo-next.css';
export function PhotoHelp({onDone,onSkip}:{onDone:()=>void;onSkip:()=>void}){return <Modal title="照片录入怎么用" onClose={onSkip}><div className="photo-help">
 <ol><li><strong>只拍本组主靶</strong><p>多靶面时先选实际靶位，让选定靶位居中，完整拍入靶纸。</p></li><li><strong>拍清接触位置</strong><p>尽量正对，停稳后拍摄；反光、模糊或遮挡时重新拍。取景标记只作构图参考。</p></li><li><strong>逐箭核对再保存</strong><p>照片结果是候选。核对箭数、X / 10 / M，补点、删错点或手动改环值；失败时可返回数字或点靶记分。</p></li></ol>
 <p className="caption">照片在本机处理；这里没有实时距离或正对检测。</p><div className="photo-help-actions"><Button onClick={onSkip}>跳过</Button><Button kind="primary" onClick={onDone}>知道了</Button></div>
 </div></Modal>;}
