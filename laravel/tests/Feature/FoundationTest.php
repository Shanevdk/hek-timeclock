<?php

namespace Tests\Feature;

use App\Models\Employee;
use App\Models\FenceJob;
use App\Models\Punch;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class FoundationTest extends TestCase
{
    use RefreshDatabase;

    private function crewMember(array $attrs = []): Employee
    {
        return Employee::create(array_merge([
            'name' => 'Test Crew',
            'email' => 'crew'.uniqid().'@test.local',
            'password' => 'secret123',
            'role' => 'crew',
            'pay_type' => 'hourly',
            'pay_rate_cents' => 2900,
            'active' => true,
        ], $attrs));
    }

    // ---- paid hours -----------------------------------------------------

    public function test_paid_time_adds_shop_time_and_subtracts_lunch(): void
    {
        $punch = new Punch([
            'clock_in' => '2026-09-14 07:00:00',
            'clock_out' => '2026-09-14 16:00:00', // 9h
            'shop_minutes' => 45,                 // +0.75
            'lunch_minutes' => 30,                // -0.50
        ]);

        $this->assertSame(555, $punch->paidMinutes()); // 540 + 45 - 30
        $this->assertSame(9.25, $punch->paidHours());
    }

    public function test_paid_time_is_the_plain_span_with_no_adjustments(): void
    {
        $punch = new Punch([
            'clock_in' => '2026-09-14 08:00:00',
            'clock_out' => '2026-09-14 16:30:00',
        ]);

        $this->assertSame(8.5, $punch->paidHours());
    }

    public function test_an_open_punch_has_no_payable_length(): void
    {
        $punch = new Punch(['clock_in' => '2026-09-14 08:00:00']);

        $this->assertNull($punch->paidMinutes());
        $this->assertTrue($punch->isOpen());
    }

    public function test_paid_time_is_never_negative(): void
    {
        $punch = new Punch([
            'clock_in' => '2026-09-14 08:00:00',
            'clock_out' => '2026-09-14 08:15:00', // 15 min
            'lunch_minutes' => 60,
        ]);

        $this->assertSame(0, $punch->paidMinutes());
    }

    public function test_kilometres_come_back_from_stored_tenths(): void
    {
        $this->assertSame(48.2, (new Punch(['km_tenths' => 482]))->km());
        $this->assertNull((new Punch)->km());
    }

    // ---- multi-day jobs -------------------------------------------------

    private function threeDayJob(): FenceJob
    {
        return FenceJob::create([
            'address' => '88 Birch Rd',
            'starts_on' => '2026-09-14',
            'ends_on' => '2026-09-16',
            'job_type' => 'Install',
        ]);
    }

    public function test_a_run_counts_every_day_inclusively(): void
    {
        $job = $this->threeDayJob();

        $this->assertSame(3, $job->dayCount());
        $this->assertSame('2026-09-16', $job->lastDay());
    }

    public function test_a_single_day_job_counts_as_one_day(): void
    {
        $single = FenceJob::create([
            'address' => '1 Oak',
            'starts_on' => '2026-09-14',
        ]);

        $this->assertSame(1, $single->dayCount());
        $this->assertSame('2026-09-14', $single->lastDay());
    }

    public function test_a_run_is_found_on_every_day_it_covers_and_no_others(): void
    {
        $job = $this->threeDayJob();

        $covers = fn (string $day) => FenceJob::coveringDay($day)
            ->pluck('id')->contains($job->id);

        $this->assertFalse($covers('2026-09-13'), 'the day before');
        $this->assertTrue($covers('2026-09-14'), 'day 1');
        $this->assertTrue($covers('2026-09-15'), 'day 2');
        $this->assertTrue($covers('2026-09-16'), 'day 3');
        $this->assertFalse($covers('2026-09-17'), 'the day after');
    }

    // ---- roles ----------------------------------------------------------

    public function test_only_the_owner_sees_cost(): void
    {
        $this->assertTrue($this->crewMember(['role' => 'owner'])->seesCost());
        $this->assertFalse($this->crewMember(['role' => 'crew_lead'])->seesCost());
        $this->assertFalse($this->crewMember(['role' => 'crew'])->seesCost());
    }

    public function test_owner_and_crew_lead_see_scope(): void
    {
        $this->assertTrue($this->crewMember(['role' => 'owner'])->seesScope());
        $this->assertTrue($this->crewMember(['role' => 'crew_lead'])->seesScope());
        $this->assertFalse($this->crewMember(['role' => 'crew'])->seesScope());
    }

    public function test_only_active_hourly_staff_clock_in(): void
    {
        $this->assertTrue($this->crewMember()->clocksIn());
        $this->assertFalse($this->crewMember(['pay_type' => 'salary'])->clocksIn());
        $this->assertFalse($this->crewMember(['active' => false])->clocksIn());
    }

    // ---- relationships --------------------------------------------------

    public function test_a_job_carries_its_crew(): void
    {
        $job = $this->threeDayJob();
        $lead = $this->crewMember(['role' => 'crew_lead']);
        $hand = $this->crewMember();

        $job->crew()->attach([$lead->id, $hand->id]);

        $this->assertCount(2, $job->fresh()->crew);
        $this->assertTrue($lead->fresh()->jobs->contains($job->id));
    }
}
