/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, MapPin, Search, Accessibility, ShieldCheck } from 'lucide-react';
import { TEST_CENTERS, TestCenter } from '../data/portalData';
import { useTranslation } from '../i18n';

interface CenterLocatorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CenterLocatorModal: React.FC<CenterLocatorModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [selectedState, setSelectedState] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');

  if (!isOpen) return null;

  const states = ['All', 'Delhi NCR', 'Maharashtra', 'Karnataka', 'Telangana', 'Tamil Nadu', 'West Bengal'];

  const filteredCenters = TEST_CENTERS.filter((c) => {
    if (selectedState !== 'All' && c.state !== selectedState) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.city.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl overflow-hidden my-6 flex flex-col">
        {/* Header */}
        <div className="bg-[#0F172A] text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/20 text-purple-400 rounded-lg">
              <MapPin className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold leading-none">
                {t('centers.title')}
              </h2>
              <span className="text-xs text-slate-400">
                {t('centers.subtitle')}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filter Toolbar */}
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row items-center gap-3">
          {/* Search Input */}
          <div className="relative flex-1 w-full">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('centers.searchPlaceholder')}
              className="w-full pl-9 pr-4 py-2 bg-white border border-slate-300 rounded-xl text-xs font-medium focus:ring-2 focus:ring-purple-500 focus:outline-hidden"
            />
          </div>

          {/* State Selector */}
          <div className="flex items-center gap-2 w-full sm:w-auto overflow-x-auto text-xs">
            <span className="font-bold text-slate-600 text-[11px] whitespace-nowrap">{t('centers.state')}</span>
            <select
              value={selectedState}
              onChange={(e) => setSelectedState(e.target.value)}
              className="px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs font-semibold focus:ring-2 focus:ring-purple-500 focus:outline-hidden cursor-pointer"
            >
              {states.map((st) => (
                <option key={st} value={st}>
                  {st === 'All' ? t('centers.allStates') : st}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Centers List */}
        <div className="p-6 overflow-y-auto max-h-[60vh] space-y-4">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
            <span>{t('centers.count', { count: filteredCenters.length })}</span>
            <span className="text-[11px] text-emerald-600 font-semibold flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" /> {t('centers.confirmOnAdmitCard')}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredCenters.map((center) => (
              <div
                key={center.id}
                className="p-4 rounded-xl border border-slate-200 bg-white hover:border-purple-300 hover:shadow-md transition-all space-y-3 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
                      {center.code}
                    </span>
                    <span className="text-[11px] font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full">
                      {center.city}, {center.state}
                    </span>
                  </div>

                  <h3 className="text-sm font-bold text-slate-900 mt-2 leading-snug">
                    {center.name}
                  </h3>

                  <div className="text-xs text-slate-600 mt-1 flex items-start gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                    <span>{center.address}</span>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 text-[11px] space-y-1.5">
                  <div className="flex items-center justify-between text-slate-700">
                    <span>{t('centers.capacity')}</span>
                    <strong className="font-mono text-slate-900">{t('centers.seats', { count: center.capacity })}</strong>
                  </div>
                  <div className="flex items-center justify-between text-slate-700">
                    <span>{t('centers.biometric')}</span>
                    <span className="text-slate-600 font-semibold">
                    {t('centers.sampleListing', { count: center.biometricStations })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-slate-600">
                      <Accessibility className="w-3.5 h-3.5 text-blue-600" />
                      <span>{t('centers.wheelchair')}</span>
                    </span>
                    <span className="font-bold text-slate-700">{center.hasWheelchairAccess ? t('centers.listed') : t('centers.notListed')}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {filteredCenters.length === 0 && (
            <div className="py-12 text-center text-slate-500 text-xs">
              {t('centers.none')}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
          <span>{t('centers.reportingNote')}</span>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold transition-colors"
          >
            {t('common.closeButton')}
          </button>
        </div>
      </div>
    </div>
  );
};
