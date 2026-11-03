import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import DataSources from '@/components/DataSources'

/** 運営情報のページの場所(ハッシュ)。ルーターの依存は入れず、App.tsx が location.hash を見て出し分ける */
export const ABOUT_HASH = '#/about'

/** 元の画面(手順と地図)に戻るときのハッシュ */
export const MAIN_HASH = '#/'

/** お問い合わせ先(利用者の決定 11/3:GitHub の Issues) */
export const CONTACT_TEXT = 'ご意見・不具合の報告は、GitHub のリポジトリの Issues にお寄せください。'
export const CONTACT_URL = 'https://github.com/turu64/Dispatcher/issues'

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 text-sm">
      <h2 id={id} className="font-medium">
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * 運営情報のページ(#/about)。作品の説明、ハッカソンの作品であること、ライセンス、データの出典、お問い合わせ。
 * 画面の上の端の「このサイトについて・データの出典」から開き、「画面に戻る」かブラウザの「戻る」で元の画面に戻る
 */
export default function AboutPage() {
  return (
    <div className="h-full overflow-y-auto">
      <article className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6" aria-labelledby="about-heading">
        <a href={MAIN_HASH} className="flex w-fit items-center gap-1 text-sm underline underline-offset-4 hover:text-foreground/80">
          <ArrowLeft className="size-4" aria-hidden="true" />
          画面に戻る
        </a>
        <h1 id="about-heading" className="text-xl font-semibold">
          このサイトについて
        </h1>

        <Section id="about-app" title="Dispatcher について">
          <p>
            Dispatcher は、運転士の急な欠員でバスを減便するときに、運行管理者と GTFS 担当者が使う Web アプリです。
            平日ダイヤを土曜・日祝ダイヤに切り替え、時間帯別の到達圏で影響を確かめ、AI(Claude)の提案を参考に必要な便を足し戻し、減便を反映した
            GTFS-JP を出力します。
          </p>
          <p>
            読み込んだ GTFS はサーバーに保存しません。読み込み・編集・到達圏の計算・検証は、すべてブラウザの中で行います。数字はプログラムが計算し、AI
            は解釈と説明を受け持ちます。AI は GTFS を直接書き換えず、変更はあなたが確かめて承認します。
          </p>
        </Section>

        <Section id="about-hackathon" title="ハッカソンの作品です">
          <p>ハッカソン「Built with Claude: Japan 2026」の応募作品として、期間中に新しく作りました。</p>
        </Section>

        <Section id="about-license" title="ライセンス">
          <p>Dispatcher のソースコードは MIT License です。データの利用条件は、下の「データの出典」のとおりです。</p>
        </Section>

        <DataSources />

        <Section id="about-contact" title="お問い合わせ">
          <p>{CONTACT_TEXT}</p>
          <p>
            <a className="underline underline-offset-2" href={CONTACT_URL} target="_blank" rel="noreferrer">
              {CONTACT_URL}
            </a>
          </p>
        </Section>
      </article>
    </div>
  )
}
