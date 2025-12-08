declare module 'react-plotly.js' {
  import { Component } from 'react';
  export interface PlotParams {
    data: any;
    layout?: any;
    config?: any;
    frames?: any;
    style?: any;
    useResizeHandler?: boolean;
    transition?: any;
  }
  export default class Plot extends Component<PlotParams> {}
}
