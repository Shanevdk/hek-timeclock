<?php

namespace Database\Seeders;

use App\Models\Employee;
use App\Models\FenceJob;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $owner = Employee::create([
            'name' => 'Shane Vandekrol',
            'first_name' => 'Shane',
            'last_name' => 'Vandekrol',
            'email' => 'owner@hekfencing.test',
            'password' => Hash::make('password'),
            'role' => 'owner',
            'pay_type' => 'salary',
            'pay_rate_cents' => 9_500_000, // $95,000/yr
            'active' => true,
        ]);

        $lead = Employee::create([
            'name' => 'Dan Reid',
            'email' => 'lead@hekfencing.test',
            'password' => Hash::make('password'),
            'role' => 'crew_lead',
            'pay_type' => 'hourly',
            'pay_rate_cents' => 3_800, // $38.00/hr
            'reports_to' => $owner->id,
            'active' => true,
        ]);

        $crew = Employee::create([
            'name' => 'Marc Toussaint',
            'email' => 'crew@hekfencing.test',
            'password' => Hash::make('password'),
            'role' => 'crew',
            'pay_type' => 'hourly',
            'pay_rate_cents' => 2_900, // $29.00/hr
            'reports_to' => $lead->id,
            'active' => true,
        ]);

        // A three-day install, so the multi-day behaviour has something to
        // exercise straight after a fresh migrate.
        $job = FenceJob::create([
            'address' => '88 Birch Rd, Ottawa ON',
            'description' => 'Install 300ft cedar privacy fence, 6ft',
            'starts_on' => '2026-09-14',
            'ends_on' => '2026-09-16',
            'start_time' => '07:30',
            'job_type' => 'Install',
            'confirmed' => true,
        ]);
        $job->crew()->attach([$lead->id, $crew->id]);
    }
}
