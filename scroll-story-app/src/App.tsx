import { useState, useEffect, useRef, useMemo } from 'react';
import Plot from 'react-plotly.js';
import Papa from 'papaparse';

interface LoadData {
  timestamp: Date;
  net_load_mw: number;
}

interface SolarData {
  timestamp: Date;
  ac_kw_per_kwdc: number;
}

interface MonthlyData {
  month: number;
  productionMWh: number;
  curtailmentMWh: number;
}

function App() {
  const [activeSection, setActiveSection] = useState(0);
  const [loadData, setLoadData] = useState<LoadData[]>([]);
  const [solarData, setSolarData] = useState<SolarData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [solarSizeMW, setSolarSizeMW] = useState(15);
  const [planningLimitMW, setPlanningLimitMW] = useState(10);
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Load CSV data
  useEffect(() => {
    const loadCSVData = async () => {
      try {
        // Load substation load data
        const loadResponse = await fetch('/french_king_8760_hourly_net_injection_2023.csv');
        const loadText = await loadResponse.text();

        Papa.parse<string[]>(loadText, {
          complete: (results) => {
            const parsed = results.data
              .filter(row => row.length >= 2 && row[0] && row[1])
              .map(row => ({
                timestamp: new Date(row[0]),
                net_load_mw: -parseFloat(row[1]), // Convert injection to load
              }));
            setLoadData(parsed);
          },
        });

        // Load solar data
        const solarResponse = await fetch('/us_ma_franklin_2023_pv_1kwdc.csv');
        const solarText = await solarResponse.text();

        Papa.parse<{ timestamp: string; ac_kw_per_kwdc: string }>(solarText, {
          header: true,
          complete: (results) => {
            const parsed = results.data
              .filter(row => row.timestamp && row.ac_kw_per_kwdc)
              .map(row => ({
                timestamp: new Date(row.timestamp),
                ac_kw_per_kwdc: parseFloat(row.ac_kw_per_kwdc),
              }));
            setSolarData(parsed);
            setIsLoading(false);
          },
        });
      } catch (error) {
        console.error('Error loading data:', error);
        setIsLoading(false);
      }
    };

    loadCSVData();
  }, []);

  // Intersection Observer for section detection
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const sectionIndex = parseInt(entry.target.getAttribute('data-section') || '0');
            setActiveSection(sectionIndex);
          }
        });
      },
      {
        root: null, // Use viewport as root
        threshold: 0.5,
      }
    );

    sectionRefs.current.forEach((section) => {
      if (section) observer.observe(section);
    });

    return () => observer.disconnect();
  }, []);

  // Helper functions
  const filterDataByDate = (data: LoadData[], startDate: string, endDate?: string) => {
    const start = new Date(startDate);
    start.setHours(0, 0, 0);
    const end = endDate ? new Date(endDate) : new Date(startDate);
    end.setHours(23, 59, 59);

    return data.filter(d => d.timestamp >= start && d.timestamp <= end);
  };

  function buildReverseFlowSeries(
    x: Date[],
    y: number[],
  ) {
    const xOut: Date[] = [];
    const yOut: (number | null)[] = [];

    for (let i = 0; i < x.length - 1; i++) {
      const x0 = x[i];
      const x1 = x[i + 1];
      const y0 = y[i];
      const y1 = y[i + 1];

      // always keep original point
      xOut.push(x0);
      yOut.push(y0 <= 0 ? y0 : null);

      // sign change across zero?
      const crossesZero = (y0 <= 0 && y1 > 0) || (y0 > 0 && y1 <= 0);
      if (crossesZero && y1 !== y0) {
        const t0 = x0.getTime();
        const t1 = x1.getTime();
        const frac = -y0 / (y1 - y0); // 0..1

        const tCross = new Date(t0 + (t1 - t0) * frac);

        xOut.push(tCross);
        yOut.push(0); // exact zero crossing
      }
    }

    // last original point
    const lastIdx = x.length - 1;
    xOut.push(x[lastIdx]);
    yOut.push(y[lastIdx] <= 0 ? y[lastIdx] : null);

    return { x: xOut, y: yOut };
  }

  // Calculate monthly production and curtailment statistics
  const calculateMonthlyStats = (solarSize: number, thermalLimit: number): MonthlyData[] => {
    const monthlyData: MonthlyData[] = [];

    for (let month = 0; month < 12; month++) {
      let production = 0;
      let curtailment = 0;

      solarData.forEach(s => {
        if (s.timestamp.getMonth() === month) {
          const outputRaw = s.ac_kw_per_kwdc * solarSize;

          const matchingLoad = loadData.find(l =>
            Math.abs(l.timestamp.getTime() - s.timestamp.getTime()) < 3600000
          );

          if (matchingLoad) {
            const capacity = matchingLoad.net_load_mw - thermalLimit;
            const outputFI = Math.min(outputRaw, capacity);
            production += outputFI;
            curtailment += outputRaw - outputFI;
          }
        }
      });

      monthlyData.push({
        month,
        productionMWh: production,  // Already in MWh since solarSize is in MW
        curtailmentMWh: curtailment,
      });
    }

    return monthlyData;
  };

  // Calculate annual curtailment percentage
  const calculateAnnualCurtailmentPct = (monthlyData: MonthlyData[]): number => {
    const totalProduction = monthlyData.reduce((sum, m) => sum + m.productionMWh, 0);
    const totalCurtailment = monthlyData.reduce((sum, m) => sum + m.curtailmentMWh, 0);

    return totalCurtailment > 0
      ? (100 * totalCurtailment / (totalProduction + totalCurtailment))
      : 0;
  };

  // Generate multi-day interactive plot
  const generateMultiDayPlot = (solarSize: number, thermalLimit: number) => {
    const tenDayData = filterDataByDate(loadData, '2023-05-16', '2023-05-20');
    const timestamps = tenDayData.map(d => d.timestamp);
    const realTimeCapacity = tenDayData.map(d => d.net_load_mw - thermalLimit);

    const solarForPeriod = solarData.filter(s => {
      const t = s.timestamp.getTime();
      return t >= timestamps[0].getTime() && t <= timestamps[timestamps.length - 1].getTime();
    });

    const solarOutputRaw = solarForPeriod.map(s => s.ac_kw_per_kwdc * solarSize);
    const solarOutputFI = solarOutputRaw.map((output, idx) => {
      const closestCapIdx = timestamps.findIndex(t =>
        Math.abs(t.getTime() - solarForPeriod[idx].timestamp.getTime()) < 3600000
      );
      if (closestCapIdx >= 0) {
        return Math.min(output, realTimeCapacity[closestCapIdx]);
      }
      return output;
    });

    return {
      data: [
        {
          x: solarForPeriod.map(s => s.timestamp),
          y: solarOutputFI,
          type: 'scatter' as const,
          mode: 'lines' as const,
          name: 'Solar output',
          line: { color: '#f59e0b', width: 3 },
        },
        {
          x: solarForPeriod.map(s => s.timestamp),
          y: solarOutputRaw,
          type: 'scatter' as const,
          mode: 'lines' as const,
          name: 'Curtailed',
          fill: 'tonexty',
          fillcolor: 'rgba(255, 232, 100, 0.4)',
          line: { color: '#f59e0b', width: 3, dash: 'dot' },
        },
        {
          x: timestamps,
          y: realTimeCapacity,
          type: 'scatter' as const,
          mode: 'lines' as const,
          name: 'Real-time<br>hosting capacity',
          line: { color: '#3b82f6', width: 3 },
        },
      ],
      layout: {
        title: 'Multi-Day View',
        xaxis: {
          title: '',
          range: [timestamps[0].getTime(), timestamps[timestamps.length - 1].getTime()],
        },
        yaxis: { title: { text: 'MW' }, automargin: true },
        legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'center', x: 0.5 },
        hovermode: 'x unified' as const,
      },
    };
  };

  // Generate monthly bar chart
  const generateMonthlyBarChart = (solarSize: number, thermalLimit: number) => {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthlyData = calculateMonthlyStats(solarSize, thermalLimit);
    const annualCurtPct = calculateAnnualCurtailmentPct(monthlyData);

    const totalProduction = monthlyData.reduce((sum, m) => sum + m.productionMWh, 0);
    const totalProductionGWh = totalProduction / 1000;

    return {
      data: [
        {
          x: monthNames,
          y: monthlyData.map(m => m.productionMWh),
          type: 'bar' as const,
          name: 'Production',
          marker: { color: '#10b981' },
        },
        {
          x: monthNames,
          y: monthlyData.map(m => m.curtailmentMWh),
          type: 'bar' as const,
          name: 'Curtailment',
          marker: { color: '#fbbf24' },
        },
      ],
      layout: {
        title: 'Monthly Production & Curtailment',
        xaxis: { title: 'Month' },
        yaxis: { title: { text: 'MWh' }, automargin: true },
        barmode: 'stack' as const,
        legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'center', x: 0.5 },
        annotations: [
          {
            text: `<b>Annual Production:</b> ${totalProductionGWh.toFixed(1)} GWh<br><b>Curtailment:</b> ${annualCurtPct.toFixed(1)}%`,
            xref: 'paper',
            yref: 'paper',
            x: 0.98,
            y: 0.98,
            xanchor: 'right',
            yanchor: 'top',
            showarrow: false,
            bgcolor: 'rgba(255, 255, 255, 0.9)',
            bordercolor: '#e5e7eb',
            borderwidth: 1,
            borderpad: 8,
            font: { size: 16 },
          },
        ],
      },
    };
  };

  // Generate plots based on active section
  const generatePlot = (section: number) => {
    if (isLoading || loadData.length === 0) {
      return {
        data: [],
        layout: {
          title: 'Loading data...',
          xaxis: { title: 'Time' },
          yaxis: { title: 'Power (MW)' },
        },
      };
    }

    const THERMAL_LIMIT = -10.0;

    switch (section) {
      case 0: {
        // Section 1: Single day showing reverse power flow
        const dayData = filterDataByDate(loadData, '2023-05-18');
        const timestamps = dayData.map(d => d.timestamp);
        const netLoad = dayData.map(d => d.net_load_mw);
        const reverseSeries = buildReverseFlowSeries(timestamps, netLoad);

        return {
          data: [
            {
              x: timestamps,
              y: netLoad,
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Net load',
              line: { color: '#374151', width: 7 },
            },
            {
              x: reverseSeries.x,
              y: reverseSeries.y,
              type: 'scatter' as const,
              mode: 'none' as const,
              fill: 'tozeroy',
              connectgaps: true,
              fillcolor: 'rgba(255, 182, 193, 0.4)',
              name: 'Reverse power flow',
            },
          ],
          layout: {
            title: 'May 18, 2023 - Net Load',
            xaxis: {
              title: '',
              range: [timestamps[0].getTime(), timestamps[timestamps.length - 1].getTime()],
            },
            yaxis: { title: { text: 'MW' }, automargin: true },
            legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'center', x: 0.5 },
            hovermode: 'x unified' as const,
          },
        };
      }

      case 1: {
        // Section 2: Single day with thermal limit and hosting capacity
        const dayData = filterDataByDate(loadData, '2023-05-18');
        const timestamps = dayData.map(d => d.timestamp);
        const netLoad = dayData.map(d => d.net_load_mw);
        const reverseSeries = buildReverseFlowSeries(timestamps, netLoad);
        const minLoad = Math.min(...netLoad);
        const minLoadTime = timestamps[netLoad.indexOf(minLoad)];

        return {
          data: [
            {
              x: timestamps,
              y: netLoad,
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Net load',
              line: { color: '#374151', width: 7 },
            },
            {
              x: [timestamps[0], timestamps[timestamps.length - 1]],
              y: [THERMAL_LIMIT, THERMAL_LIMIT],
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Planning limit',
              line: { color: 'red', width: 7, dash: 'dash' },
            },
            {
              x: reverseSeries.x,
              y: reverseSeries.y,
              type: 'scatter' as const,
              mode: 'none' as const,
              fill: 'tozeroy',
              connectgaps: true,
              fillcolor: 'rgba(255, 182, 193, 0.4)',
              name: 'Reverse power flow',
            },
          ],
          layout: {
            title: 'Hosting Capacity Constrained by Thermal Limit',
            xaxis: {
              title: '',
              range: [timestamps[0].getTime(), timestamps[timestamps.length - 1].getTime()],
            },
            yaxis: { title: { text: 'MW' }, automargin: true },
            annotations: [{
              x: minLoadTime.getTime(),
              y: minLoad,
              text: '<b>Thermal hosting capacity</b>',
              showarrow: true,
              arrowhead: 2,
              arrowsize: 1,
              arrowwidth: 5,
              arrowcolor: '#155dfc',
              xref: 'x',
              yref: 'y',
              axref: 'x',
              ayref: 'y',
              ax: minLoadTime.getTime(),
              ay: (minLoad + THERMAL_LIMIT) / 2,
              font: { color: '#155dfc', size: 24 },
            },
            {
              x: minLoadTime.getTime(),
              y: THERMAL_LIMIT,
              text: '   ',
              showarrow: true,
              arrowhead: 2,
              arrowsize: 1,
              arrowwidth: 5,
              arrowcolor: '#155dfc',
              xref: 'x',
              yref: 'y',
              axref: 'x',
              ayref: 'y',
              ax: minLoadTime.getTime(),
              ay: (minLoad + THERMAL_LIMIT) / 2,
              font: { color: '#155dfc', size: 24 },
            },
            ],
            legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'center', x: 0.5 },
            hovermode: 'x unified' as const,
          },
        };
      }

      case 2: {
        // Section 3: Week view showing variable hosting capacity
        const weekData = filterDataByDate(loadData, '2023-05-15', '2023-05-21');
        const timestamps = weekData.map(d => d.timestamp);
        const netLoad = weekData.map(d => d.net_load_mw);

        // Calculate daily minimums and create horizontal lines + arrows
        const dailyLines: any[] = [];
        const annotations: any[] = [];
        const days = ['2023-05-15', '2023-05-16', '2023-05-17', '2023-05-18', '2023-05-19', '2023-05-20', '2023-05-21'];

        days.forEach(dayStr => {
          const dayData = filterDataByDate(weekData, dayStr);
          if (dayData.length === 0) return;

          const dayNetLoad = dayData.map(d => d.net_load_mw);
          const dayTimestamps = dayData.map(d => d.timestamp);
          const minLoad = Math.min(...dayNetLoad);
          const minLoadIdx = dayNetLoad.indexOf(minLoad);
          const minLoadTime = dayTimestamps[minLoadIdx];

          const dayStart = new Date(dayStr);
          dayStart.setHours(0, 0, 0);
          const dayEnd = new Date(dayStr);
          dayEnd.setHours(23, 59, 59);

          // Horizontal line at daily minimum
          dailyLines.push({
            x: [dayStart, dayEnd],
            y: [minLoad, minLoad],
            type: 'scatter' as const,
            mode: 'lines' as const,
            line: { color: 'blue', width: 4, dash: 'dot' },
            showlegend: false,
            hoverinfo: 'skip',
          });

          // Add double-headed arrow annotation
          annotations.push({
            x: minLoadTime.getTime(),
            y: THERMAL_LIMIT,
            text: '   ',
            showarrow: true,
            arrowhead: 2,
            arrowsize: 1,
            arrowwidth: 5,
            arrowcolor: 'blue',
            xref: 'x',
            yref: 'y',
            axref: 'x',
            ayref: 'y',
            ax: minLoadTime.getTime(),
            ay: minLoad,
          });

          annotations.push({
            x: minLoadTime.getTime(),
            y: minLoad,
            text: '   ',
            showarrow: true,
            arrowhead: 2,
            arrowsize: 1,
            arrowwidth: 5,
            arrowcolor: 'blue',
            xref: 'x',
            yref: 'y',
            axref: 'x',
            ayref: 'y',
            ax: minLoadTime.getTime(),
            ay: THERMAL_LIMIT,
          });
        });

        return {
          data: [
            {
              x: timestamps,
              y: netLoad,
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Net load',
              line: { color: '#374151', width: 7 },
            },
            {
              x: [timestamps[0], timestamps[timestamps.length - 1]],
              y: [THERMAL_LIMIT, THERMAL_LIMIT],
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Planning limit',
              line: { color: 'red', width: 7, dash: 'dash' },
            },
            ...dailyLines,
          ],
          layout: {
            title: 'Hosting Capacity Varies Day to Day',
            xaxis: {
              title: '',
              range: [timestamps[0].getTime(), timestamps[timestamps.length - 1].getTime()],
            },
            yaxis: { title: { text: 'MW' }, automargin: true },
            annotations,
            legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'center', x: 0.5 },
            hovermode: 'x unified' as const,
          },
        };
      }

      case 3: {
        // Section 4: Full year with static hosting capacity
        const timestamps = loadData.map(d => d.timestamp);
        const netLoad = loadData.map(d => d.net_load_mw);
        const minLoad = Math.min(...netLoad);
        const minLoadTime = timestamps[netLoad.indexOf(minLoad)];

        return {
          data: [
            {
              x: timestamps,
              y: netLoad,
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Net load',
              line: { color: '#374151', width: 1 },
            },
            {
              x: [timestamps[0], timestamps[timestamps.length - 1]],
              y: [THERMAL_LIMIT, THERMAL_LIMIT],
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Planning limit',
              line: { color: 'red', width: 7, dash: 'dash' },
            },
            {
              x: [timestamps[0], timestamps[timestamps.length - 1]],
              y: [minLoad, minLoad],
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Minimum net load',
              line: { color: 'blue', width: 7, dash: 'dot' },
            },
          ],
          layout: {
            title: 'Traditional: Based on Worst Hour of Year',
            xaxis: {
              title: '',
              range: [timestamps[0].getTime(), timestamps[timestamps.length - 1].getTime()],
            },
            yaxis: { title: { text: 'MW' }, automargin: true },
            annotations: [{
              x: minLoadTime.getTime(),
              y: minLoad,
              text: '<b>Annual static<br>hosting capacity</b>',
              showarrow: true,
              arrowhead: 2,
              arrowsize: 1,
              arrowwidth: 5,
              arrowcolor: '#155dfc',
              xref: 'x',
              yref: 'y',
              axref: 'x',
              ayref: 'y',
              ax: minLoadTime.getTime(),
              ay: (minLoad + THERMAL_LIMIT) / 2,
              font: { color: '#155dfc', size: 24 },
            },
            {
              x: minLoadTime.getTime(),
              y: THERMAL_LIMIT,
              text: '   <br>   ',
              showarrow: true,
              arrowhead: 2,
              arrowsize: 1,
              arrowwidth: 5,
              arrowcolor: '#155dfc',
              xref: 'x',
              yref: 'y',
              axref: 'x',
              ayref: 'y',
              ax: minLoadTime.getTime(),
              ay: (minLoad + THERMAL_LIMIT) / 2,
              font: { color: '#155dfc', size: 24 },
            }],
            legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'center', x: 0.5 },
            hovermode: 'x unified' as const,
          },
        };
      }

      case 4: {
        // Section 5: 10-day view with constrained solar
        const tenDayData = filterDataByDate(loadData, '2023-05-16', '2023-05-20');
        const timestamps = tenDayData.map(d => d.timestamp);
        const realTimeCapacity = tenDayData.map(d => d.net_load_mw - THERMAL_LIMIT);

        const minCapacity = Math.min(...realTimeCapacity);

        // Merge with solar data
        const solarForPeriod = solarData.filter(s => {
          const t = s.timestamp.getTime();
          return t >= timestamps[0].getTime() && t <= timestamps[timestamps.length - 1].getTime();
        });

        const staticSolarOutput = solarForPeriod.map(s => s.ac_kw_per_kwdc * minCapacity);

        return {
          data: [
            {
              x: timestamps,
              y: realTimeCapacity,
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Real-time hosting capacity',
              line: { color: '#3b82f6', width: 3 },
            },
            {
              x: solarForPeriod.map(s => s.timestamp),
              y: staticSolarOutput,
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Solar output (static limit)',
              line: { color: '#f59e0b', width: 3 },
            },
          ],
          layout: {
            title: 'Static Limit Wastes Available Capacity',
            xaxis: {
              title: '',
              range: [timestamps[0].getTime(), timestamps[timestamps.length - 1].getTime()],
            },
            yaxis: { title: { text: 'MW' }, automargin: true, range: [0, Math.max(...realTimeCapacity) * 1.1] },
            legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'center', x: 0.5 },
            hovermode: 'x unified' as const,
          },
        };
      }

      case 5: {
        // Section 6: 10-day view with flexible interconnection
        const tenDayData = filterDataByDate(loadData, '2023-05-16', '2023-05-20');
        const timestamps = tenDayData.map(d => d.timestamp);
        const realTimeCapacity = tenDayData.map(d => d.net_load_mw - THERMAL_LIMIT);

        const SOLAR_SIZE_DC = 15; // MW

        const solarForPeriod = solarData.filter(s => {
          const t = s.timestamp.getTime();
          return t >= timestamps[0].getTime() && t <= timestamps[timestamps.length - 1].getTime();
        });

        const solarOutputRaw = solarForPeriod.map(s => s.ac_kw_per_kwdc * SOLAR_SIZE_DC);
        const solarOutputFI = solarOutputRaw.map((output, idx) => {
          // Match with real-time capacity
          const closestCapIdx = timestamps.findIndex(t =>
            Math.abs(t.getTime() - solarForPeriod[idx].timestamp.getTime()) < 3600000
          );
          if (closestCapIdx >= 0) {
            return Math.min(output, realTimeCapacity[closestCapIdx]);
          }
          return output;
        });

        return {
          data: [
            {
              x: solarForPeriod.map(s => s.timestamp),
              y: solarOutputFI,
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Solar output',
              line: { color: '#f59e0b', width: 3 },
            },
            {
              x: solarForPeriod.map(s => s.timestamp),
              y: solarOutputRaw,
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Curtailed',
              fill: 'tonexty',
              fillcolor: 'rgba(255, 232, 100, 0.4)',
              line: { color: '#f59e0b', width: 3, dash: 'dot' },
            },
            {
              x: timestamps,
              y: realTimeCapacity,
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: 'Real-time<br>hosting capacity',
              line: { color: '#3b82f6', width: 3 },
            },
          ],
          layout: {
            title: 'Flexible Interconnection: Real-Time Curtailment',
            xaxis: {
              title: '',
              range: [timestamps[0].getTime(), timestamps[timestamps.length - 1].getTime()],
            },
            yaxis: { title: { text: 'MW' }, automargin: true, range: [0, Math.max(...realTimeCapacity) * 1.1] },
            legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'center', x: 0.5 },
            hovermode: 'x unified' as const,
          },
        };
      }

      case 6: {
        // Section 7: Annual energy comparison bar chart
        const realTimeCapacity = loadData.map(d => d.net_load_mw - THERMAL_LIMIT);
        const minCapacity = Math.min(...realTimeCapacity);

        const sizes = [minCapacity, 10, 15];
        const annualMWh: number[] = [];
        const annualCurtailedMWh: number[] = [];

        sizes.forEach(size => {
          let totalMWh = 0;
          let curtailedMWh = 0;

          solarData.forEach(s => {
            const outputRaw = s.ac_kw_per_kwdc * size;

            // Find matching load data
            const matchingLoad = loadData.find(l =>
              Math.abs(l.timestamp.getTime() - s.timestamp.getTime()) < 3600000
            );

            if (matchingLoad) {
              const capacity = matchingLoad.net_load_mw - THERMAL_LIMIT;
              const outputFI = Math.min(outputRaw, capacity);
              totalMWh += outputFI;
              curtailedMWh += outputRaw - outputFI;
            }
          });

          annualMWh.push(totalMWh / 1000); // Convert to GWh
          annualCurtailedMWh.push(curtailedMWh / 1000);
        });

        const labels = [
          `${sizes[0].toFixed(1)} MW`,
          `${sizes[1].toFixed(1)} MW`,
          `${sizes[2].toFixed(1)} MW`,
        ];

        const totalGWh = annualMWh.map((gwh, idx) => gwh + annualCurtailedMWh[idx]);
        const pctCurt = annualCurtailedMWh.map((curt, idx) =>
          totalGWh[idx] > 0 ? (100 * curt / totalGWh[idx]) : 0
        );

        return {
          data: [
            {
              x: labels,
              y: annualMWh,
              type: 'bar' as const,
              name: 'Annual generation',
              marker: { color: '#10b981' },
            },
            {
              x: labels,
              y: annualCurtailedMWh,
              type: 'bar' as const,
              name: 'Annual curtailed energy',
              marker: { color: '#93c5fd' },
            },
          ],
          layout: {
            title: 'Annual Energy Production Comparison',
            xaxis: { title: 'Solar size' },
            yaxis: { title: { text: 'Annual energy (GWh)' }, automargin: true, },
            barmode: 'stack' as const,
            legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'center', x: 0.5 },
            annotations: pctCurt.map((pct, idx) => ({
              x: labels[idx],
              y: totalGWh[idx],
              text: `${pct.toFixed(1)}% curtailed`,
              showarrow: false,
              yanchor: 'bottom',
              font: { size: 24 },
            })),
          },
        };
      }

      default:
        return {
          data: [],
          layout: {
            title: 'Loading...',
            xaxis: { title: 'Time' },
            yaxis: { title: 'Power (MW)' },
          },
        };
    }
  };

  const plotConfig = generatePlot(activeSection);

  // Memoized interactive plots
  const multiDayPlotConfig = useMemo(() => {
    if (isLoading || loadData.length === 0 || solarData.length === 0) {
      return { data: [], layout: { title: 'Loading...' } };
    }
    return generateMultiDayPlot(solarSizeMW, -planningLimitMW);
  }, [solarSizeMW, planningLimitMW, loadData, solarData, isLoading]);

  const monthlyPlotConfig = useMemo(() => {
    if (isLoading || loadData.length === 0 || solarData.length === 0) {
      return { data: [], layout: { title: 'Loading...' } };
    }
    return generateMonthlyBarChart(solarSizeMW, -planningLimitMW);
  }, [solarSizeMW, planningLimitMW, loadData, solarData, isLoading]);

  return (
    <div className="w-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Two-column section */}
      <div className="flex w-screen">
        {/* Left side: Fixed Plotly chart */}
        <div className="w-1/2 h-screen flex items-center justify-center p-8 bg-white border-r border-gray-200 sticky top-0">
          <div className="w-full max-w-3xl aspect-[4/3]">
            <Plot
              data={plotConfig.data}
              layout={{
                ...plotConfig.layout,
                autosize: true,
                margin: { l: 80, r: 40, t: 60, b: 60 },
                plot_bgcolor: '#ffffff',
                paper_bgcolor: '#ffffff',
                font: {
                  family: 'system-ui, -apple-system, sans-serif',
                  color: '#374151',
                  size: 24,
                },
                transition: {
                  duration: 600,
                  easing: 'cubic-in-out',
                },
              }}
              config={{
                displayModeBar: false,
                responsive: true,
              }}
              style={{ width: '100%', height: '100%' }}
              useResizeHandler={true}
              transition={{
                duration: 600,
                easing: 'cubic-in-out',
              }}
              frames={[]}
            />
          </div>
        </div>

        {/* Right side: Scrollable text */}
        <div className="w-1/2 bg-gradient-to-b from-white to-gray-50">
          <div className="max-w-2xl mx-auto px-12 py-16">
            {/* Section 1 */}
            <div
              ref={(el) => { sectionRefs.current[0] = el; }}
              data-section="0"
              className="min-h-screen flex flex-col justify-center mb-32 relative"
            >
              {/* <h1 className="text-5xl font-bold mb-6 text-gray-900">
                  Flexible Interconnection
                </h1> */}
              <h2 className="text-3xl font-semibold mb-8 text-gray-900">
                Getting more out of our grid with flexible interconnection
              </h2>
              <p className="text-3xl text-gray-700 leading-relaxed mb-4">
                Traditionally, the grid is built for the highest load hour of each year.
                As we add solar, we start seeing <span className="text-pink-500 font-semibold">reverse power flow</span> when
                solar produces more electricity than can be consumed locally.
              </p>
              <p className="text-lg text-gray-500 italic mb-4">
                *Note: net load data are for an actual Eversource substation in western Massachusetts.
              </p>

              <p className="text-lg text-gray-500 italic">
                Created by{' '}
                <a
                  href="https://dawzylla.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline"
                >
                  Charles Dawson
                </a>
              </p>

              {/* Scroll to continue indicator */}
              <div className="absolute bottom-24 left-1/2 transform -translate-x-1/2 flex items-center gap-2">
                <span className="text-sm text-gray-400">Scroll to continue</span>
                <svg
                  className="w-8 h-8 text-gray-400"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>
                </svg>
              </div>
            </div>

            {/* Section 2 */}
            <div
              ref={(el) => { sectionRefs.current[1] = el; }}
              data-section="1"
              className="min-h-screen flex flex-col justify-center mb-32"
            >
              <p className="text-3xl text-gray-700 leading-relaxed mb-4">
                As <span className="text-pink-500 font-semibold">reverse power flow</span> approaches
                the <span className="text-red-600 font-semibold">thermal limit</span> of the local grid,
                this limits the <span className="text-blue-600 font-semibold">hosting capacity</span> of
                the circuit (i.e. the ability of the grid to accomodate new solar).
              </p>
              <p className="text-lg text-gray-500 italic mt-4">
                This plot shows a 10 MW thermal limit for illustration; the actual limit of this substation is higher.
              </p>
            </div>

            {/* Section 3 */}
            <div
              ref={(el) => { sectionRefs.current[2] = el; }}
              data-section="2"
              className="min-h-screen flex flex-col justify-center mb-32"
            >
              <p className="text-3xl text-gray-700 leading-relaxed">
                However, <span className="text-blue-600 font-semibold">hosting capacity</span> is not static;
                it varies from day to day based on weather, load, and other grid conditions.
              </p>
            </div>

            {/* Section 4 */}
            <div
              ref={(el) => { sectionRefs.current[3] = el; }}
              data-section="3"
              className="min-h-screen flex flex-col justify-center mb-32"
            >
              <p className="text-3xl text-gray-700 leading-relaxed">
                Traditional interconnection sets limits based on the worst hour of the year,
                requiring expensive grid upgrades to accomodate more solar.
              </p>
            </div>

            {/* Section 5 */}
            <div
              ref={(el) => { sectionRefs.current[4] = el; }}
              data-section="4"
              className="min-h-screen flex flex-col justify-center mb-32"
            >
              <p className="text-3xl text-gray-700 leading-relaxed">
                Even though most days don't come close to the limit, the
                worst-case scenario limits the amount of solar that can be installed.
              </p>
            </div>

            {/* Section 6 */}
            <div
              ref={(el) => { sectionRefs.current[5] = el; }}
              data-section="5"
              className="min-h-screen flex flex-col justify-center mb-32"
            >
              <p className="text-3xl text-gray-700 leading-relaxed">
                <span className="font-semibold">Flexible interconnection</span> uses the precise amount of hosting capacity available in real time,
                rather than the static limit. When the grid is congested, solar output
                &nbsp;<span className="bg-orange-100 text-orange-800 px-1">curtails</span>&nbsp;
                (i.e. turns down).
              </p>
            </div>

            {/* Section 7 */}
            <div
              ref={(el) => { sectionRefs.current[6] = el; }}
              data-section="6"
              className="min-h-screen flex flex-col justify-center mb-32 relative"
            >
              <p className="text-3xl text-gray-700 leading-relaxed">
                Over the course of the year, flexible interconnection allows solar to generate
                much more electricity without overloading the grid, and only a small fraction ends up curtailed.
              </p>

              {/* Try it yourself indicator */}
              <div className="absolute bottom-24 left-1/2 transform -translate-x-1/2 flex items-center gap-2">
                <span className="text-sm text-gray-400">Try it for yourself!</span>
                <svg
                  className="w-8 h-8 text-gray-400"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Full-width interactive section */}
      <div className="w-full h-screen flex flex-col bg-gradient-to-br from-gray-50 to-gray-100">
        {/* Controls area */}
        <div className="p-8 bg-white border-b border-gray-200">
          <h2 className="text-4xl font-bold mb-6 text-gray-900">
            Flexible interconnection in action
          </h2>

          <div className="max-w-4xl mx-auto grid grid-cols-2 gap-8">
            {/* Solar Size Slider */}
            <div>
              <div className="flex justify-between mb-2">
                <label className="text-lg font-semibold text-gray-700">Solar Plant Size</label>
                <span className="text-lg text-gray-600">{solarSizeMW.toFixed(1)} MW</span>
              </div>
              <input
                type="range"
                min={5}
                max={30}
                step={0.5}
                value={solarSizeMW}
                onChange={(e) => setSolarSizeMW(parseFloat(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
              />
            </div>

            {/* Planning Limit Slider */}
            <div>
              <div className="flex justify-between mb-2">
                <label className="text-lg font-semibold text-gray-700">Planning Limit (Thermal)</label>
                <span className="text-lg text-gray-600">{planningLimitMW.toFixed(1)} MW</span>
              </div>
              <input
                type="range"
                min={5}
                max={20}
                step={0.5}
                value={planningLimitMW}
                onChange={(e) => setPlanningLimitMW(parseFloat(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* Plots area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Multi-day plot */}
          <div className="w-1/2 p-6 flex items-center justify-center">
            <div className="w-full h-full">
              <Plot
                data={multiDayPlotConfig.data}
                layout={{
                  ...multiDayPlotConfig.layout,
                  autosize: true,
                  margin: { l: 80, r: 40, t: 60, b: 60 },
                  plot_bgcolor: '#ffffff',
                  paper_bgcolor: '#ffffff',
                  font: {
                    family: 'system-ui, -apple-system, sans-serif',
                    color: '#374151',
                    size: 20,
                  },
                }}
                config={{
                  displayModeBar: false,
                  responsive: true,
                }}
                style={{ width: '100%', height: '100%' }}
                useResizeHandler={true}
              />
            </div>
          </div>

          {/* Monthly bar chart */}
          <div className="w-1/2 p-6 flex items-center justify-center border-l border-gray-200">
            <div className="w-full h-full">
              <Plot
                data={monthlyPlotConfig.data}
                layout={{
                  ...monthlyPlotConfig.layout,
                  autosize: true,
                  margin: { l: 80, r: 40, t: 60, b: 60 },
                  plot_bgcolor: '#ffffff',
                  paper_bgcolor: '#ffffff',
                  font: {
                    family: 'system-ui, -apple-system, sans-serif',
                    color: '#374151',
                    size: 20,
                  },
                }}
                config={{
                  displayModeBar: false,
                  responsive: true,
                }}
                style={{ width: '100%', height: '100%' }}
                useResizeHandler={true}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="w-full py-6 bg-gray-800 text-center">
        <p className="text-gray-300">
          Created by{' '}
          <a
            href="https://dawzylla.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline"
          >
            Charles Dawson
          </a>
        </p>
      </div>
    </div>
  );
}

export default App;
