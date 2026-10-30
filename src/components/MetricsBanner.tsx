/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { UserRound, ClipboardCheck, Building2, ShieldCheck, MessageSquareText } from 'lucide-react';

export const MetricsBanner: React.FC = () => {
  const metrics = [
    {
      value: 'Candidate',
      label: 'Dedicated portal',
      icon: UserRound,
      textColor: 'text-[#16A34A]',
      iconColor: 'text-[#16A34A]',
    },
    {
      value: 'Applications',
      label: 'Online submission',
      icon: ClipboardCheck,
      textColor: 'text-[#0284C7]',
      iconColor: 'text-[#0284C7]',
    },
    {
      value: 'Centers',
      label: 'Assigned candidate check-in',
      icon: Building2,
      textColor: 'text-[#9333EA]',
      iconColor: 'text-[#9333EA]',
    },
    {
      value: 'Secure',
      label: 'Role-based account access',
      icon: ShieldCheck,
      textColor: 'text-[#16A34A]',
      iconColor: 'text-[#16A34A]',
    },
    {
      value: 'Helpdesk',
      label: 'Feedback and issue reports',
      icon: MessageSquareText,
      textColor: 'text-[#D97706]',
      iconColor: 'text-[#D97706]',
    },
  ];

  return (
    <div className="bg-white border-b border-slate-200/90 shadow-2xs">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 lg:gap-6 divide-y sm:divide-y-0 sm:divide-x divide-slate-100">
          {metrics.map((item, idx) => {
            const Icon = item.icon;
            return (
              <div
                key={idx}
                className={`flex items-center gap-3 justify-center sm:justify-start px-2 lg:px-4 ${
                  idx > 0 ? 'pt-3 sm:pt-0' : ''
                }`}
              >
                <div className="p-2 rounded-lg bg-slate-50 shrink-0">
                  <Icon className={`w-6 h-6 ${item.iconColor}`} />
                </div>
                <div className="flex flex-col">
                  <span className={`text-xl sm:text-2xl font-extrabold tracking-tight leading-none tabular-nums ${item.textColor}`}>
                    {item.value}
                  </span>
                  <span className="text-xs font-semibold text-slate-700 mt-1 leading-snug">
                    {item.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
